"""Resolve one mobile-web SABR session. Secrets cross only the private child pipes."""
import hashlib
import json
import re
import tempfile
from pathlib import Path
import sys
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit

from yt_dlp import YoutubeDL
from yt_dlp.extractor.youtube import _video
from yt_dlp.utils import update_url_query


class PlaybackReady(Exception):
    """The pinned yt-dlp extractor has reached its format-selection boundary."""


class MobileWebIE(_video.YoutubeIE):
    video_token = None
    mobile_config = None
    return_config = False

    def _download_ytcfg(self, client, video_id):
        if client != 'mweb':
            return super()._download_ytcfg(client, video_id)
        if self.mobile_config is None:
            self.mobile_config = super()._download_ytcfg(client, video_id)
        return self.mobile_config

    def _load_player(self, video_id, player_url, fatal=True):
        # Only the immutable public JavaScript is shared. Player responses, proofs and
        # signed media URLs stay in this job. The container admits one job at a time.
        address = urlsplit(player_url)
        if (address.scheme != 'https' or address.hostname not in ('www.youtube.com', 'm.youtube.com')
                or not re.search(r'/s/player/[0-9a-f]{8,}/', address.path)):
            return super()._load_player(video_id, player_url, fatal)
        key = hashlib.sha256(player_url.encode()).hexdigest()
        cache = Path(tempfile.gettempdir()) / 'video2ctx-public-player.json'
        try:
            saved = json.loads(cache.read_text())
            if saved['key'] == key and isinstance(saved['code'], str):
                return saved['code']
        except (OSError, ValueError, KeyError, TypeError):
            pass
        code = super()._load_player(video_id, player_url, fatal)
        if code and len(code) <= 8 * 1024 * 1024:
            try:
                pending = cache.with_suffix('.new')
                pending.write_text(json.dumps({'key': key, 'code': code}))
                pending.replace(cache)
            except OSError:
                pass
        return code

    def _fetch_po_token(self, client, **options):
        token = super()._fetch_po_token(client, **options)
        # An anonymous web session can omit the experiment flag selecting video-bound proof.
        # Mint both supported bindings on the same provider session when the flag is absent.
        if token and options.get('context') == 'gvs' and not options.get('_gvs_bind_to_video_id'):
            self.video_token = super()._fetch_po_token(client, **{**options, '_gvs_bind_to_video_id': True})
        return token

    @classmethod
    def ie_key(cls):
        return _video.YoutubeIE.ie_key()

    def _extract_formats_and_subtitles(self, video_id, player_responses, player_url, live_status, duration):
        for response in player_responses:
            streams = response.get('streamingData') or {}
            if streams.get(_video.STREAMING_DATA_CLIENT_NAME) != 'mweb':
                continue
            details = response.get('videoDetails', {})
            if details.get('videoId') != video_id or live_status in ('is_live', 'is_upcoming', 'post_live'):
                continue
            url = streams.get('serverAbrStreamingUrl')
            config = (response.get('playerConfig', {}).get('mediaCommonConfig', {})
                      .get('mediaUstreamerRequestConfig', {}).get('videoPlaybackUstreamerConfig'))
            if not url or not config:
                continue
            fetch_token = streams[_video.STREAMING_DATA_FETCH_GVS_PO_TOKEN]
            # The token provider and JS solver perform independent network and CPU work.
            with ThreadPoolExecutor(max_workers=1) as executor:
                pending_token = executor.submit(fetch_token, required=True)
                challenges = parse_qs(urlsplit(url).query).get('n')
                if challenges:
                    request = _video.JsChallengeRequest(
                        type=_video.JsChallengeType.N, video_id=video_id,
                        input=_video.NChallengeInput(challenges=challenges, player_url=player_url))
                    solved = next((answer.output.results.get(challenges[0])
                                   for _, answer in self._jsc_director.bulk_solve([request])), None)
                    if not solved:
                        raise ValueError('challenge')
                    url = update_url_query(url, {'n': solved})
                token = pending_token.result()
            if not token:
                raise ValueError('token')
            client = self._extract_context(fetch_token.keywords.get('ytcfg'), 'mweb')['client']
            formats = [{k: v for k, v in f.items() if not k.startswith('__')}
                       for f in streams.get('adaptiveFormats', [])]
            raise PlaybackReady(dict(url=url, config=config, token=token, videoToken=self.video_token, formats=formats, mobileConfig=self.mobile_config if self.return_config else None,
                                     clientVersion=client['clientVersion'], userAgent=client.get('userAgent')))
        raise ValueError('No attested mobile-web stream')


def main():
    request = json.load(sys.stdin)
    options = {
        'quiet': True, 'no_warnings': True, 'cachedir': False, 'proxy': request['proxy'],
        'socket_timeout': 7, 'extractor_retries': 0, 'retries': 0, 'js_runtimes': {'node': {}},
        'extractor_args': {'youtube': {'player_client': ['mweb'], 'player_skip': ['webpage', 'initial_data']},
                           'youtubepot-bgutilscript': {'disable': ['true']}},
    }
    with YoutubeDL(options) as downloader:
        try:
            extractor = MobileWebIE(downloader)
            extractor.mobile_config = request.get('mobileConfig')
            extractor.return_config = request.get('returnConfig', False)
            extractor.extract('https://www.youtube.com/watch?v=' + request['videoId'])
        except PlaybackReady as result:
            json.dump(result.args[0], sys.stdout)
            return
    raise ValueError('No playback session')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only fixed categories cross the pipe. Provider exceptions can contain signed URLs.
        detail = str(error).lower()
        if 'not a bot' in detail or 'sign in' in detail:
            code = 'AUTH_REQUIRED'
        elif 'timeout' in detail or 'timed out' in detail:
            code = 'FRAME_TIMEOUT'
        elif detail in ('challenge', 'token'):
            code = 'AUTH_REQUIRED'
        elif isinstance(error, (AttributeError, TypeError, KeyError, ImportError)):
            code = 'DEPENDENCY_MISSING'
        else:
            code = 'MEDIA_UNAVAILABLE'
        json.dump({'failure': code}, sys.stdout)

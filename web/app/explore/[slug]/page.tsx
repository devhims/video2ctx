import { notFound } from 'next/navigation';
import { DIRECTIONS, getDirection } from '../../_directions/registry';
import { DirectionSwitcher } from '../../_components/direction-switcher';

export function generateStaticParams() {
  return DIRECTIONS.map((direction) => ({ slug: direction.slug }));
}

export default async function DirectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const direction = getDirection(slug);
  if (!direction) notFound();

  return (
    <>
      {direction.render()}
      <DirectionSwitcher current={direction.slug} />
    </>
  );
}

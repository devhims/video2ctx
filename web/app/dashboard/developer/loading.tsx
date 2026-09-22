import { WorkspaceShell } from '../WorkspaceShell';
import styles from './DeveloperSettings.module.css';
export default function DeveloperLoading() {
  return (
    <WorkspaceShell section='developer' title='API keys'>
      <section className={styles.page} aria-label='Manage API keys'>
        <section>
          <header className={styles.intro}>
            <h2>Create an API key</h2>
            <p>Connect your scripts and integrations to video2ctx.</p>
          </header>
          <div className={styles.form} aria-hidden='true'>
            <label>Key name</label>
            <div className={styles.inputRow}>
              <input disabled placeholder='e.g. Production integration' />
              <button disabled>Create key</button>
            </div>
            <p className={styles.formNote}>Uses your account credits. Active until revoked.</p>
          </div>
          <p className={styles.hint}>Keep keys server-side. Never include them in browser code or source control.</p>
        </section>
        <section className={styles.keys}>
          <header className={styles.listHeading}>
            <h2>Active keys</h2>
            <span>Only key prefixes are shown</span>
          </header>
          <div className={styles.keyList} role='status' aria-label='Loading API keys' aria-busy='true'>
            {[0, 1, 2].map((index) => (
              <div className={styles.keyRow} key={index} aria-hidden='true'>
                <span className={styles.keyIcon} />
                <div className={styles.keyIdentity}>
                  <strong>
                    <i className='ui-bar' data-width='medium' />
                  </strong>
                  <code>
                    <i className='ui-bar' data-width='short' />
                  </code>
                  <dl>
                    <div>
                      <dt>Created</dt>
                      <dd className='skeleton-action'>
                        <i className='ui-bar' />
                      </dd>
                    </div>
                    <div>
                      <dt>Last used</dt>
                      <dd className='skeleton-action'>
                        <i className='ui-bar' />
                      </dd>
                    </div>
                  </dl>
                </div>
                <span className={styles.revoke}>
                  <i className='ui-bar skeleton-key-action' />
                </span>
              </div>
            ))}
          </div>
        </section>
      </section>
    </WorkspaceShell>
  );
}

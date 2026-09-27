import styles from './HistoryEmptyState.module.css';

export function HistoryEmptyState({ title, description }: { title: string; description: string }) {
  return <div className={styles.empty}><h3>{title}</h3><p>{description}</p></div>;
}

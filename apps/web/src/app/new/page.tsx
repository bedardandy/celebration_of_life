import Link from 'next/link';
import styles from '../page.module.css';

export const metadata = {
  title: 'Create a memorial',
};

export default function NewMemorialPage() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Coming soon</h1>
        <p className={styles.promise}>
          This is where we will ask you a few gentle questions and set things up. It is not ready
          yet.
        </p>
        <Link className={styles.stepBack} href="/">
          Back
        </Link>
      </div>
    </main>
  );
}

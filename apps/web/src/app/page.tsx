import Link from 'next/link';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@col/core';
import styles from './page.module.css';

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{PRODUCT_NAME}</h1>
        <p className={styles.promise}>{PRODUCT_TAGLINE}</p>
        <Link className={styles.cta} href="/new">
          Create a memorial
        </Link>
        <p className={styles.reassurance}>
          You can stop at any point and come back. Nothing is lost, and nothing is shared until you
          say so.
        </p>
      </div>
    </main>
  );
}

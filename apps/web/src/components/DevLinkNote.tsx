/**
 * The magic link, on screen, in development only.
 *
 * There is no mail server in development, so without this the product is not
 * walkable: you would create a memorial and have no way to test the link that
 * gets you back in. The transport refuses to hand the link back outside
 * development, so this renders nothing in production.
 */
import styles from './DevLinkNote.module.css';

export function DevLinkNote({ link }: { link?: string }) {
  if (!link) return null;
  return (
    <div className={styles.note} data-testid="dev-link">
      <p className={styles.label}>Development only — no email was sent</p>
      <a className={styles.link} href={link}>
        {link}
      </a>
    </div>
  );
}

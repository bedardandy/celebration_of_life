/**
 * Auditioning a song before naming it.
 *
 * One module, one job: turn a few words into a handful of thirty-second
 * previews so the family can be sure which recording they mean. Nothing here
 * touches the database, the blob store or the timeline — a preview is heard and
 * then forgotten, and the only thing that outlives this screen is the song's
 * name typed into a text field.
 */
export * from './itunes';

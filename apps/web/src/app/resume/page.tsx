import { ResumeForm } from './ResumeForm';

export const metadata = { title: 'Send me a link' };

export default async function ResumePage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  return <ResumeForm signedOut={reason === 'signed-out' || reason === 'link-used'} />;
}

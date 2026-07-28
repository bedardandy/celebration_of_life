import Link from 'next/link';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';

export default function LandingPage() {
  return (
    <StepScreen
      eyebrow={PRODUCT_NAME}
      title="A gentle way to gather photos, memories, and music"
      helper={PRODUCT_TAGLINE}
      primary={
        <Link className={step.primary} href="/new">
          Create a memorial
        </Link>
      }
      secondary={
        <Link className={step.quiet} href="/resume">
          I already have one
        </Link>
      }
      footer={
        <>
          You can stop at any point and come back. Everything saves as you go, and nothing is shared
          until you say so.
        </>
      }
    />
  );
}

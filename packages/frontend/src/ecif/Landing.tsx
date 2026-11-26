import { useEffect, useRef } from 'react';
import './ecif.css';
import { scrollToTop } from './scrollTop';

export type Role = 'requestor' | 'reviewer';

/** First page of the app. Shown before sign-in. */
export default function Landing({ onPick }: { onPick: (r: Role) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollToTop(ref.current); }, []);
  return (
    <div className="ecif landing" ref={ref}>
      <header className="landing-hero">
        <p className="landing-kicker">Microsoft ECIF</p>
        <h1>ECIF Supplier Scope &amp; Milestones</h1>
        <p className="landing-lead">
          Create, submit and review End Customer Investment Fund (ECIF) requests in one place.
        </p>
      </header>

      <section className="landing-grid">
        <article className="card landing-card">
          <h2>About ECIF</h2>
          <p>
            The End Customer Investment Fund (ECIF) is Microsoft funding for project work that a supplier delivers to an end customer.
            Each request describes the customer, the supplier, the project scope and the milestones, with the roles, hours and amounts behind them.
          </p>
          <p className="hint">Approval can take up to 2 weeks, so choose the project start date with that in mind.</p>
        </article>

        <article className="card landing-card">
          <h2>How it works</h2>
          <ol className="landing-steps">
            <li><strong>Fill in</strong> the account and contact details, the project scope and the milestones.</li>
            <li><strong>Check</strong> the milestone details and the summary with its totals.</li>
            <li><strong>Submit</strong> the request. It is locked while it is being reviewed.</li>
            <li><strong>Reviewer decides:</strong> approve, request changes or reject, with a comment.</li>
          </ol>
        </article>
      </section>

      <section className="landing-choice">
        <h2>Choose how you want to continue</h2>
        <div className="landing-grid">
          <article className="card landing-card landing-role">
            <h3>Requestor</h3>
            <p>For suppliers and Microsoft contacts who create ECIF requests, track their status and see reviewer decisions.</p>
            <button type="button" onClick={() => onPick('requestor')}>Sign in as requestor</button>
          </article>
          <article className="card landing-card landing-role">
            <h3>Reviewer</h3>
            <p>For approved reviewers who see all submitted requests and approve, reject or ask for changes.</p>
            <button type="button" onClick={() => onPick('reviewer')}>Sign in as reviewer</button>
            <p className="hint">Reviewer access is limited to people on the approved reviewer list.</p>
          </article>
        </div>
        <p className="hint landing-note">
          Both options use the same Microsoft sign-in. Which screens you can open depends on your account.
        </p>
      </section>
    </div>
  );
}
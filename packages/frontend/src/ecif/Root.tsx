import { useEffect, useRef, useState } from 'react';
import { isReviewerEmail } from '@rayfin-app/shared';
import { currentUser } from './api';
import EcifApp from './EcifApp';
import type { Role } from './Landing';
import ReviewerApp from './ReviewerApp';
import { scrollToTop } from './scrollTop';

interface Props {
  role: Role;
  /** Change role, or null to go back to the landing page. */
  onRole: (r: Role | null) => void;
}

/** Shown after sign-in. Which screen opens depends on the role chosen on the landing page. */
export default function EcifRoot({ role, onRole }: Props) {
  const [email, setEmail] = useState<string | null>(null);
  const [isReviewer, setIsReviewer] = useState(false);
  const [view, setView] = useState<'review' | 'mine'>('review');
  const topRef = useRef<HTMLDivElement>(null);

  // Always start at the top when a screen opens (the landing page may have been scrolled).
  useEffect(() => { scrollToTop(topRef.current); }, [role, view]);

  useEffect(() => {
    currentUser()
      .then((u) => { setEmail(u.email); setIsReviewer(isReviewerEmail(u.email)); })
      .catch(() => setEmail(''));
  }, []);

  const bar = (
    <div className="ecif mode-switch no-print landing-bar">
      <span className="hint">
        Signed in as {email || '(email not available)'} - {role === 'reviewer' && isReviewer ? 'reviewer' : 'requestor'}
      </span>
      <span className="landing-bar-actions">
        {role === 'reviewer' && isReviewer && (
          <>
            <button type="button" className={view === 'review' ? '' : 'secondary'} onClick={() => setView('review')}>Review requests</button>
            <button type="button" className={view === 'mine' ? '' : 'secondary'} onClick={() => setView('mine')}>My requests</button>
          </>
        )}
        <button type="button" className="secondary" onClick={() => onRole(null)}>Home</button>
      </span>
    </div>
  );

  if (role === 'reviewer') {
    if (email === null) {
      return <div ref={topRef}>{bar}<div className="ecif"><p className="hint">Checking your access...</p></div></div>;
    }
    if (!isReviewer) {
      return (
        <div ref={topRef}>
          {bar}
          <div className="ecif">
            <section className="card">
              <h2>You are not on the reviewer list</h2>
              <p>
                The account {email ? <strong>{email}</strong> : 'you signed in with'} does not have reviewer access.
                Ask the app owner to add it, or continue as a requestor.
              </p>
              <div className="actions">
                <button type="button" onClick={() => onRole('requestor')}>Continue as requestor</button>
                <button type="button" className="secondary" onClick={() => onRole(null)}>Back to home</button>
              </div>
            </section>
          </div>
        </div>
      );
    }
    return <div ref={topRef}>{bar}{view === 'review' ? <ReviewerApp /> : <EcifApp />}</div>;
  }

  return <div ref={topRef}>{bar}<EcifApp /></div>;
}
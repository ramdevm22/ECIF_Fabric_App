//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import App from './App.tsx';
import { ErrorFallback } from './ErrorFallback';
import Landing from './ecif/Landing';
import type { Role } from './ecif/Landing';
import { AuthGate } from './components/auth-gate.component';
import { ThemeContext } from './hooks/theme.context';
import { AuthProvider } from './hooks/use-auth';
import { useAppTheme } from './hooks/use-theme';
import type { IAuthService } from './services/rayfin-auth.service';

const ROLE_KEY = 'ecif.role';

// Remembered for this browser tab only, so a sign-in redirect returns to the chosen role.
function readRole(): Role | null {
  try {
    const v = sessionStorage.getItem(ROLE_KEY);
    return v === 'requestor' || v === 'reviewer' ? v : null;
  } catch {
    return null;
  }
}

function saveRole(r: Role | null) {
  try {
    if (r) sessionStorage.setItem(ROLE_KEY, r);
    else sessionStorage.removeItem(ROLE_KEY);
  } catch {
    // storage may be blocked; the app still works
  }
}

export function Root({
  rayfinAuthService,
}: {
  rayfinAuthService: IAuthService;
}) {
  const { isDark, toggleTheme } = useAppTheme();
  const [role, setRoleState] = useState<Role | null>(readRole);
  const setRole = (r: Role | null) => {
    saveRole(r);
    setRoleState(r);
  };

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      <ErrorBoundary FallbackComponent={ErrorFallback}>
        <AuthProvider rayfinAuthService={rayfinAuthService}>
          {role ? (
            <AuthGate>
              <App role={role} onRole={setRole} />
            </AuthGate>
          ) : (
            <Landing onPick={setRole} />
          )}
        </AuthProvider>
      </ErrorBoundary>
    </ThemeContext.Provider>
  );
}
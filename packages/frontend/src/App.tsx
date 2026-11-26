//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import EcifRoot from './ecif/Root';
import type { Role } from './ecif/Landing';

// The ECIF app replaces the template's starter view.
function App({ role, onRole }: { role: Role; onRole: (r: Role | null) => void }) {
  return <EcifRoot role={role} onRole={onRole} />;
}

export default App;
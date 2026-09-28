import { HttpContextToken } from '@angular/common/http';

/**
 * A request for which 401 does not mean the end of this tab's session (the interceptor then does not handle it),
 * e.g. ending an old session from the login screen (`AuthService.confirmLogout`).
 * Set via `new HttpContext().set(IGNORE_UNAUTHORIZED, true)`.
 * A separate file, so that `auth.service.ts` and `auth.interceptor.ts` do not import each other.
 */
export const IGNORE_UNAUTHORIZED = new HttpContextToken<boolean>(() => false);

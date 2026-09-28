/**
 * Returns a safe return address after login.
 *
 * Allows only paths inside the app. Rejects full addresses, protocol-relative addresses
 * (`//host`, `/\host`) and a return to the login screen itself, so that `?returnUrl=` cannot be used
 * to redirect to a foreign site.
 */
export function safeReturnUrl(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/';
  }
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) {
    return '/';
  }
  return raw;
}

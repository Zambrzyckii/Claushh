import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';

import { AuthService } from './auth.service';

/**
 * Lets in only with a valid session. Without one, redirects to /login with a return address.
 * After an unconfirmed logout (marker `AuthService.pendingLogout`), it does not let in, but sends to the screen
 * that ends that session: neither "Back" nor a new tab gets back into the app, even though the session on the server may be alive.
 * The marker is also checked after the server responds, because another tab may have written it in the meantime.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.pendingLogout() !== null) {
    return unconfirmedLogoutPage(router);
  }
  if (await auth.ensureSession()) {
    return auth.pendingLogout() !== null ? unconfirmedLogoutPage(router) : true;
  }
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/**
 * Login screen only for users who are not logged in. A logged-in user is sent to the app.
 * Exception: unconfirmed logout (marker `AuthService.pendingLogout`). The session on the server may have survived,
 * and still returning to the app is not allowed: the user wanted to leave it and must see the warning on
 * `/login?logout=unconfirmed` (the screen retries the logout). Without the marker, this address (e.g. an external link or an old
 * history entry) is checked like any other login screen. Exception to the exception: `&marker=none`, when the marker
 * could not be written because storage does not work (checked here, so an external link cannot force it).
 */
export const guestGuard: CanActivateFn = async (route) => {
  const router = inject(Router);
  const auth = inject(AuthService);
  const unconfirmedPage = route.queryParamMap.get('logout') === 'unconfirmed';
  if (auth.pendingLogout() !== null) {
    return unconfirmedPage ? true : unconfirmedLogoutPage(router);
  }
  if (unconfirmedPage && route.queryParamMap.get('marker') === 'none' && !auth.storageAvailable()) {
    return true;
  }
  if (await auth.ensureSession()) {
    return auth.pendingLogout() !== null ? unconfirmedLogoutPage(router) : router.createUrlTree(['/']);
  }
  return true;
};

function unconfirmedLogoutPage(router: Router): UrlTree {
  return router.createUrlTree(['/login'], { queryParams: { logout: 'unconfirmed' } });
}

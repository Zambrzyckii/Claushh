import { Routes } from '@angular/router';

// TODO(stage 1): add a guard that requires login for the root path.
export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login').then((m) => m.Login)
  },
  {
    path: '',
    loadComponent: () => import('./features/workspace/workspace').then((m) => m.Workspace)
  },
  { path: '**', redirectTo: '' }
];

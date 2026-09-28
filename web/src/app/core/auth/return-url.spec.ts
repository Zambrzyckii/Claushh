import { safeReturnUrl } from './return-url';

describe('safeReturnUrl', () => {
  it.each(['/', '/projects', '/projects?open=src%2Fmain.c', '/a/b#c', '/loginx'])(
    'keeps the in-app path %s',
    (url) => expect(safeReturnUrl(url)).toBe(url)
  );

  it.each([
    null,
    undefined,
    '',
    'projects',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/login',
    '/login?returnUrl=/x',
    '/login/'
  ])('replaces the unsafe value %s with /', (url) => expect(safeReturnUrl(url)).toBe('/'));
});

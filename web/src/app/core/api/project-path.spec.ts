import { baseName, isSafeRelativePath, joinPath } from './project-path';

describe('project paths', () => {
  it.each(['', 'a', 'studia/lab/src/main.c', '.gitignore', 'a/.hidden/b', 'a..b/c'])('accepts %s', (path) =>
    expect(isSafeRelativePath(path)).toBe(true)
  );

  it.each(['/etc/passwd', '..', '../x', 'a/../../x', 'a/./b', 'a//b', 'a/', 'a\\b', '..\\x', 'a\0b'])(
    'rejects %s',
    (path) => expect(isSafeRelativePath(path)).toBe(false)
  );

  it('extracts the base name', () => {
    expect(baseName('src/main.c')).toBe('main.c');
    expect(baseName('main.c')).toBe('main.c');
  });

  it('joins paths', () => {
    expect(joinPath('', 'a')).toBe('a');
    expect(joinPath('a/b', 'c')).toBe('a/b/c');
  });
});

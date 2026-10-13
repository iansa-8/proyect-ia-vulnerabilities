import { validateProjectPath, PathValidationError } from './path-validation';

describe('validateProjectPath', () => {
  it('accepts absolute windows paths', () => {
    const result = validateProjectPath('C:\\Users\\demo\\project');
    expect(result.toLowerCase()).toContain('users');
  });

  it('rejects empty paths', () => {
    expect(() => validateProjectPath('   ')).toThrow(PathValidationError);
  });

  it('rejects relative paths', () => {
    expect(() => validateProjectPath('relative\\folder')).toThrow(PathValidationError);
  });

  it('rejects path traversal segments', () => {
    expect(() => validateProjectPath('C:\\Users\\demo\\..\\secret')).toThrow(
      PathValidationError,
    );
  });

  it('rejects null bytes', () => {
    expect(() => validateProjectPath('C:\\Users\\demo\\a\0b')).toThrow(PathValidationError);
  });
});

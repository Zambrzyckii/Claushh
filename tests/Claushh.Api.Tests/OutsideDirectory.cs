namespace Claushh.Api.Tests;

// A temporary directory outside the projects directory, as the target of symlinks that lead out; deleted afterwards.
public sealed class OutsideDirectory : IDisposable
{
    public string Root { get; } = Directory.CreateTempSubdirectory("claushh-outside-").FullName;

    public string Child(string name) => Path.Join(Root, name);

    public void Dispose() => Directory.Delete(Root, recursive: true);
}

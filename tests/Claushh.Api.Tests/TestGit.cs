// Test repositories made with the git CLI (docs/ARCHITECTURE.md, "Tests"): a fixed identity and date, so every run
// makes the same commits, and HOME set to ApiFactory.GitHome, so the machine's git configuration stays out.
using System.Diagnostics;
using System.Text;

namespace Claushh.Api.Tests;

public sealed class TestGit(ApiFactory api)
{
    // The author and committer date of every test commit: 2026-09-01T10:00:00Z.
    public const string Date = "2026-09-01T12:00:00+02:00";

    // An empty repository on the branch main in the projects directory; returns its directory.
    public string Init(string relative)
    {
        var path = api.ProjectPath(relative);
        Directory.CreateDirectory(path);
        Run(path, "init", "-q", "-b", "main");
        return path;
    }

    // A repository with one commit "first" (README.md).
    public string MakeRepo(string relative)
    {
        var path = Init(relative);
        Commit(path, "README.md", $"# {Path.GetFileName(path)}\n", "first");
        return path;
    }

    // A repository with one commit, pushed to a new remote of the same name, which it tracks as origin/main.
    public string MakeTrackedRepo(string relative)
    {
        var path = MakeRepo(relative);
        Run(path, "remote", "add", "origin", MakeRemote(Path.GetFileName(path)));
        Run(path, "push", "-q", "-u", "origin", "main");
        return path;
    }

    // An empty bare repository in RemotesRoot; returns the URL a repository uses for it.
    public string MakeRemote(string name)
    {
        Run(api.RemotesRoot, "init", "-q", "--bare", "-b", "main", $"{name}.git");
        return RemoteUrl(name);
    }

    // A remote with one commit "first" (README.md), pushed from a clone elsewhere.
    public string MakeSeededRemote(string name)
    {
        var url = MakeRemote(name);
        var seed = CloneElsewhere(url);
        Commit(seed, "README.md", $"# {name}\n", "first");
        Run(seed, "push", "-q", "origin", "main");
        return url;
    }

    // An https URL, as GitHub's: the test git configuration (ApiFactory.GitConfig) leads it to RemotesRoot.
    public string RemoteUrl(string name) => $"https://git.test/{name}.git";

    // A clone outside the projects directory ("another computer"), for commits that reach a remote from elsewhere.
    public string CloneElsewhere(string url)
    {
        var path = Path.Join(api.RemotesRoot, "clones", Guid.NewGuid().ToString("N"));
        Run(api.RemotesRoot, "clone", "-q", url, path);
        return path;
    }

    // Writes a file in a repository and commits everything.
    public void Commit(string repository, string file, string text, string message)
    {
        var path = Path.Join(repository, file);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
        CommitAll(repository, message);
    }

    public void CommitAll(string repository, string message)
    {
        Run(repository, "add", "-A");
        Run(repository, "commit", "-q", "-m", message);
    }

    // Fails the test when git fails; returns stdout.
    public string Run(string directory, params string[] arguments)
    {
        var (exitCode, output, error) = RunUnchecked(directory, arguments);
        Assert.True(exitCode == 0, $"git {string.Join(' ', arguments)} failed: {error}");
        return output;
    }

    public (int ExitCode, string Output, string Error) RunUnchecked(string directory, params string[] arguments)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment["HOME"] = api.GitHome;
        start.Environment.Remove("XDG_CONFIG_HOME");
        foreach (var role in new[] { "AUTHOR", "COMMITTER" })
        {
            start.Environment[$"GIT_{role}_NAME"] = "Test";
            start.Environment[$"GIT_{role}_EMAIL"] = "test@example.invalid";
            start.Environment[$"GIT_{role}_DATE"] = Date;
        }
        using var git = Process.Start(start)!;
        var error = new StringBuilder();
        git.ErrorDataReceived += (_, line) => error.AppendLine(line.Data);
        git.BeginErrorReadLine();
        var output = git.StandardOutput.ReadToEnd();
        git.WaitForExit();
        return (git.ExitCode, output, error.ToString());
    }
}

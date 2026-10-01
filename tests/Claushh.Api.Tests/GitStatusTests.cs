using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class GitStatusTests(ApiFactory api) : ApiTest(api)
{
    private const string Long = "a line long enough for git to see the file as renamed\nline 2\nline 3\n";

    public sealed record FileBody(string Path, string Status);
    public sealed record StatusBody(string? Branch, int Ahead, int Behind, List<FileBody> Files);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Every_change_has_git_s_status_and_ignored_files_are_left_out()
    {
        var lab = Api.Git.Init("studia/lab");
        Api.WriteProjectFile("studia/lab/.gitignore", "*.log\n");
        foreach (var name in new[] { "modified.txt", "typechange.txt", "deleted.txt" })
        {
            Api.WriteProjectFile($"studia/lab/{name}", name + "\n");
        }
        Api.WriteProjectFile("studia/lab/old-name.txt", Long);
        Api.WriteProjectFile("studia/lab/moved.txt", "moved: " + Long);
        Api.Git.CommitAll(lab, "files");
        Api.WriteProjectFile("studia/lab/modified.txt", "changed\n");
        File.Delete(Api.ProjectPath("studia/lab/typechange.txt"));
        Api.Link("studia/lab/typechange.txt", "modified.txt");
        File.Delete(Api.ProjectPath("studia/lab/deleted.txt"));
        Api.Git.Run(lab, "mv", "old-name.txt", "new-name.txt");
        File.Move(Api.ProjectPath("studia/lab/moved.txt"), Api.ProjectPath("studia/lab/moved-on-disk.txt"));
        Api.WriteProjectFile("studia/lab/added.txt", "added\n");
        Api.Git.Run(lab, "add", "added.txt");
        Api.WriteProjectFile("studia/lab/new/a.txt", "a\n");
        Api.WriteProjectFile("studia/lab/new/deep/b.txt", "b\n");
        Api.WriteProjectFile("studia/lab/debug.log", "ignored\n");

        var status = await StatusOkAsync("studia/lab");

        Assert.Equal("main", status.Branch);
        Assert.Equal(new[]
            {
                new FileBody("studia/lab/added.txt", "added"),
                new FileBody("studia/lab/deleted.txt", "deleted"),
                new FileBody("studia/lab/modified.txt", "modified"),
                // A rename that is not staged is a deletion plus a new file, as in `git status`.
                new FileBody("studia/lab/moved-on-disk.txt", "untracked"),
                new FileBody("studia/lab/moved.txt", "deleted"),
                new FileBody("studia/lab/new-name.txt", "renamed"),
                new FileBody("studia/lab/new/a.txt", "untracked"),
                new FileBody("studia/lab/new/deep/b.txt", "untracked"),
                new FileBody("studia/lab/typechange.txt", "modified"),
            },
            status.Files.OrderBy(file => file.Path, StringComparer.Ordinal));
    }

    [Fact]
    public async Task A_merge_conflict_is_conflicted()
    {
        var lab = Api.Git.MakeRepo("studia/lab");
        Api.Git.Run(lab, "checkout", "-q", "-b", "other");
        Api.Git.Commit(lab, "README.md", "other side\n", "other side");
        Api.Git.Run(lab, "checkout", "-q", "main");
        Api.Git.Commit(lab, "README.md", "main side\n", "main side");
        Assert.NotEqual(0, Api.Git.RunUnchecked(lab, "merge", "other").ExitCode);

        var status = await StatusOkAsync("studia/lab");

        Assert.Equal(new[] { new FileBody("studia/lab/README.md", "conflicted") }, status.Files);
    }

    [Fact]
    public async Task Ahead_and_behind_are_as_fresh_as_the_last_fetch()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Commit(elsewhere, "b.txt", "b\n", "b");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Api.Git.Commit(lab, "c.txt", "c\n", "c");

        var before = await StatusOkAsync("studia/lab");
        Api.Git.Run(lab, "fetch", "-q", "origin");
        var after = await StatusOkAsync("studia/lab");

        Assert.Equal((1, 0), (before.Ahead, before.Behind));
        Assert.Equal((1, 2), (after.Ahead, after.Behind));
        Assert.Empty(after.Files);
    }

    [Theory]
    [InlineData("studia/missing")]
    [InlineData("studia/plain")]
    [InlineData("studia/file.txt")]
    [InlineData("studia/linked")]
    [InlineData("studia/worktree")]
    [InlineData("studia/reftable")]
    [InlineData(".hidden/lab")]
    public async Task What_is_not_a_repository_is_404(string repo)
    {
        Api.Git.MakeRepo("studia/lab");
        Api.Git.MakeRepo(".hidden/lab");
        Directory.CreateDirectory(Api.ProjectPath("studia/plain"));
        Api.WriteProjectFile("studia/file.txt", "x");
        Api.Link("studia/linked", Api.ProjectPath("studia/lab"));
        Api.WriteProjectFile("studia/worktree/.git", $"gitdir: {Api.ProjectPath("studia/lab/.git")}\n");
        Api.Git.Run(Api.ProjectPath("studia"), "init", "-q", "--ref-format=reftable", "-b", "main", "reftable");

        Assert.Equal(HttpStatusCode.NotFound, (await StatusAsync(repo)).StatusCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("studia")]
    [InlineData("studia/lab/src")]
    [InlineData("studia/../lab")]
    [InlineData("../studia")]
    [InlineData("studia/.git")]
    public async Task A_repo_that_is_not_two_valid_path_segments_is_400(string repo)
    {
        Api.Git.MakeRepo("studia/lab");

        Assert.Equal(HttpStatusCode.BadRequest, (await StatusAsync(repo)).StatusCode);
    }

    [Fact]
    public async Task Without_the_parameter_it_is_400_and_without_a_session_401()
    {
        Api.Git.MakeRepo("studia/lab");

        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.GetAsync("/api/git/status")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await new ApiClient(Api).Http.GetAsync("/api/git/status?repo=studia%2Flab")).StatusCode);
    }

    private Task<HttpResponseMessage> StatusAsync(string repo) =>
        Client.Http.GetAsync($"/api/git/status?repo={Uri.EscapeDataString(repo)}");

    private async Task<StatusBody> StatusOkAsync(string repo)
    {
        var response = await StatusAsync(repo);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<StatusBody>())!;
    }
}

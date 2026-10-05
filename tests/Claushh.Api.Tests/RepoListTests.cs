using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class RepoListTests(ApiFactory api) : ApiTest(api)
{
    public sealed record CommitBody(string Message, string Date);
    public sealed record RepoBody(string Name, string Path, string? Branch, int Changes, string? Upstream, int Ahead, int Behind, CommitBody? LastCommit);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Lists_every_field_of_a_repository()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "from-elsewhere.txt", "x\n", "from another computer");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Api.Git.Commit(lab, "src/main.c", "int main() {}\n", "parser: szkielet parse_ipv4\n\nThe body is not shown.");
        Api.Git.Run(lab, "fetch", "-q", "origin");
        Api.WriteProjectFile("studia/lab/README.md", "changed\n");
        Api.WriteProjectFile("studia/lab/notes/todo.txt", "new\n");

        var repo = Assert.Single(await ListAsync("studia"));
        var status = await Client.Http.GetFromJsonAsync<GitStatusTests.StatusBody>("/api/git/status?repo=studia%2Flab");

        Assert.Equal(new RepoBody("lab", "studia/lab", "main", 2, "origin/main", 1, 1,
            new CommitBody("parser: szkielet parse_ipv4", "2026-09-01T10:00:00Z")), repo);
        // The table's count and the status bar's count must agree.
        Assert.Equal(repo.Changes, status!.Files.Count);
    }

    [Fact]
    public async Task Lists_only_repositories_ordered_by_name_ignoring_case()
    {
        foreach (var name in new[] { "zeta", "Beta", "alpha", "a_b", "ab", ".hidden" })
        {
            Api.Git.MakeRepo($"studia/{name}");
        }
        Api.Git.MakeRepo("prywatne/elsewhere");
        Api.Link("studia/linked", Api.ProjectPath("prywatne/elsewhere"));
        Directory.CreateDirectory(Api.ProjectPath("studia/plain"));
        Api.WriteProjectFile("studia/file.txt", "x");
        Api.WriteProjectFile("studia/worktree/.git", $"gitdir: {Api.ProjectPath("studia/zeta/.git")}\n");
        Directory.CreateDirectory(Api.ProjectPath("studia/gitlink"));
        Api.Link("studia/gitlink/.git", Api.ProjectPath("studia/zeta/.git"));
        Api.WriteProjectFile("studia/broken/.git/HEAD", "ref: refs/heads/main\n");
        Api.Git.Run(Api.ProjectPath("studia"), "init", "-q", "--ref-format=reftable", "-b", "main", "reftable");

        var names = (await ListAsync("studia")).Select(repo => repo.Name);

        // Compared upper-cased, as .NET's OrdinalIgnoreCase does: "L" < "_" < lower-case letters.
        Assert.Equal(new[] { "ab", "alpha", "a_b", "Beta", "zeta" }, names);
    }

    [Fact]
    public async Task A_detached_head_has_no_branch_and_a_repository_without_commits_no_last_commit()
    {
        var detached = Api.Git.MakeRepo("studia/detached");
        Api.Git.Commit(detached, "second.txt", "2\n", "second");
        Api.Git.Run(detached, "checkout", "-q", "--detach", "HEAD~1");
        Api.Git.Init("studia/empty");
        Api.WriteProjectFile("studia/empty/draft.txt", "x");

        var repos = await ListAsync("studia");

        Assert.Equal(new[]
            {
                new RepoBody("detached", "studia/detached", null, 0, null, 0, 0, new CommitBody("first", "2026-09-01T10:00:00Z")),
                new RepoBody("empty", "studia/empty", "main", 1, null, 0, 0, null),
            },
            repos);
    }

    [Fact]
    public async Task An_empty_workspace_has_no_repositories()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia"));

        Assert.Empty(await ListAsync("studia"));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("notes.txt")]
    [InlineData("linked")]
    [InlineData(".hidden")]
    public async Task What_is_not_a_workspace_is_404_with_an_empty_body(string workspace)
    {
        Directory.CreateDirectory(Api.ProjectPath("studia"));
        Directory.CreateDirectory(Api.ProjectPath(".hidden"));
        Api.WriteProjectFile("notes.txt", "x");
        Api.Link("linked", Api.ProjectPath("studia"));

        var response = await GetAsync(workspace);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("studia/lab")]
    [InlineData("..")]
    [InlineData("../studia")]
    [InlineData(".git")]
    [InlineData("stu\\dia")]
    public async Task A_workspace_that_is_not_one_valid_path_segment_is_400(string workspace)
    {
        Api.Git.MakeRepo("studia/lab");

        Assert.Equal(HttpStatusCode.BadRequest, (await GetAsync(workspace)).StatusCode);
    }

    [Fact]
    public async Task Without_the_parameter_it_is_400_and_without_a_session_401()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia"));

        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.GetAsync("/api/repos")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await new ApiClient(Api).Http.GetAsync("/api/repos?workspace=studia")).StatusCode);
    }

    private Task<HttpResponseMessage> GetAsync(string workspace) =>
        Client.Http.GetAsync($"/api/repos?workspace={Uri.EscapeDataString(workspace)}");

    private async Task<List<RepoBody>> ListAsync(string workspace)
    {
        var response = await GetAsync(workspace);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<List<RepoBody>>())!;
    }
}

using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class PullTests(ApiFactory api) : ApiTest(api)
{
    private const string Long = "a line long enough for git to see the file as renamed\nline 2\nline 3\n";

    public sealed record PullBody(string Message, List<string> ChangedPaths);
    public sealed record MessageBody(string Message);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Pulls_new_commits_and_lists_every_changed_path()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        Api.Git.Commit(lab, "old.txt", Long, "old");
        Api.Git.Run(lab, "push", "-q");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "README.md", "# changed\n", "readme");
        Api.Git.Run(elsewhere, "mv", "old.txt", "new.txt");
        Api.Git.CommitAll(elsewhere, "rename");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var pulled = (await response.Content.ReadFromJsonAsync<PullBody>())!;
        Assert.Equal("Pulled 2 commits.", pulled.Message);
        // A rename gives both of its paths.
        Assert.Equal(new[] { "studia/lab/README.md", "studia/lab/new.txt", "studia/lab/old.txt" }, pulled.ChangedPaths);
        Assert.Equal("# changed\n", File.ReadAllText(Api.ProjectPath("studia/lab/README.md")));
        Assert.False(File.Exists(Api.ProjectPath("studia/lab/old.txt")));
    }

    [Fact]
    public async Task Nothing_new_is_already_up_to_date()
    {
        Api.Git.MakeTrackedRepo("studia/lab");

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var pulled = (await response.Content.ReadFromJsonAsync<PullBody>())!;
        Assert.Equal("Already up to date.", pulled.Message);
        Assert.Empty(pulled.ChangedPaths);
    }

    [Fact]
    public async Task A_branch_without_an_upstream_or_a_detached_head_is_400()
    {
        Api.Git.MakeRepo("studia/local");
        var detached = Api.Git.MakeTrackedRepo("studia/detached");
        Api.Git.Run(detached, "checkout", "-q", "--detach", "HEAD");

        foreach (var repo in new[] { "studia/local", "studia/detached" })
        {
            var response = await PullAsync(repo);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal(new MessageBody("The branch has no upstream."), await response.Content.ReadFromJsonAsync<MessageBody>());
        }
    }

    [Fact]
    public async Task Diverged_branches_are_409_with_git_s_message()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "theirs.txt", "theirs\n", "theirs");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Api.Git.Commit(lab, "mine.txt", "mine\n", "mine");

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("Not possible to fast-forward", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Api.ProjectPath("studia/lab/theirs.txt")));
    }

    [Fact]
    public async Task A_local_change_to_an_incoming_file_is_409_and_the_file_stays()
    {
        Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "README.md", "# theirs\n", "theirs");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Api.WriteProjectFile("studia/lab/README.md", "# mine, not saved in a commit\n");

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("would be overwritten", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
        Assert.Equal("# mine, not saved in a commit\n", File.ReadAllText(Api.ProjectPath("studia/lab/README.md")));
    }

    [Fact]
    public async Task A_remote_that_is_gone_is_502()
    {
        Api.Git.MakeTrackedRepo("studia/lab");
        Directory.Delete(Api.Git.RemotePath("lab"), recursive: true);

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("fatal:", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_remote_given_as_a_local_path_is_refused()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        Api.Git.Run(lab, "remote", "set-url", "origin", Api.Git.RemotePath("lab"));
        // The test configuration still allows the file transport; the API's git does not.
        Api.AllowFileTransport(false);

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("transport 'file' not allowed", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_branch_without_commits_gets_every_file_of_its_upstream()
    {
        var url = Api.Git.MakeRemote("lab");
        Api.Git.Run(Api.ProjectPath(""), "clone", "-q", url, Api.ProjectPath("studia/lab"));
        var elsewhere = Api.Git.CloneElsewhere(url);
        Api.Git.Commit(elsewhere, "src/main.c", "int main() {}\n", "first");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Api.Git.Run(Api.ProjectPath("studia/lab"), "fetch", "-q");

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var pulled = (await response.Content.ReadFromJsonAsync<PullBody>())!;
        Assert.Equal("Pulled 1 commit.", pulled.Message);
        Assert.Equal(new[] { "studia/lab/src/main.c" }, pulled.ChangedPaths);
        Assert.True(File.Exists(Api.ProjectPath("studia/lab/src/main.c")));
    }

    [Fact]
    public async Task Pulls_into_an_empty_clone_after_the_remote_gets_a_commit_elsewhere()
    {
        var url = Api.Git.MakeRemote("empty");
        Api.Git.Run(Api.ProjectPath(""), "clone", "-q", url, Api.ProjectPath("studia/empty"));
        var elsewhere = Api.Git.CloneElsewhere(url);
        Api.Git.Commit(elsewhere, "README.md", "# empty\n", "first");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");

        var response = await PullAsync("studia/empty");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var pulled = (await response.Content.ReadFromJsonAsync<PullBody>())!;
        Assert.Equal("Pulled 1 commit.", pulled.Message);
        Assert.True(File.Exists(Api.ProjectPath("studia/empty/README.md")));
    }

    [Fact(Timeout = 30_000)]
    public async Task A_local_step_is_not_killed_when_the_client_goes_away()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        var marker = Path.Join(Api.ProjectsRoot, "post-merge-ran");
        var hook = Path.Join(lab, ".git", "hooks", "post-merge");
        File.WriteAllText(hook, $"#!/bin/sh\nsleep 2\ntouch '{marker}'\n");
        File.SetUnixFileMode(hook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        using var cts = new CancellationTokenSource();
        cts.CancelAfter(TimeSpan.FromMilliseconds(500));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Client.Http.PostAsync($"/api/git/pull?repo={Uri.EscapeDataString("studia/lab")}", null, cts.Token));
        await Task.Delay(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);

        Assert.True(File.Exists(marker), "the post-merge hook must run to completion despite the client going away");
        Assert.Equal(Api.Git.Run(elsewhere, "rev-parse", "main"), Api.Git.Run(lab, "rev-parse", "HEAD"));
    }

    [Fact]
    public async Task Two_pulls_at_once_run_one_after_the_other()
    {
        Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");

        var responses = await Task.WhenAll(PullAsync("studia/lab"), PullAsync("studia/lab"));

        var messages = new List<string>();
        foreach (var response in responses)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            messages.Add((await response.Content.ReadFromJsonAsync<PullBody>())!.Message);
        }
        Assert.Equal(new[] { "Already up to date.", "Pulled 1 commit." }, messages.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Pulling_needs_a_session_the_xsrf_token_and_a_repository()
    {
        Api.Git.MakeTrackedRepo("studia/lab");

        Assert.Equal(HttpStatusCode.Unauthorized, (await new ApiClient(Api).Http.PostAsync("/api/git/pull?repo=studia%2Flab", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await PullAsync("studia/missing")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await PullAsync("studia")).StatusCode);
        Client.SendXsrf = false;
        Assert.Equal(HttpStatusCode.BadRequest, (await PullAsync("studia/lab")).StatusCode);
    }

    // git holds its ref locks while the reference-transaction hook runs for "prepared"; the hook outlasts the 2 s limit,
    // so the API stops git while it holds them.
    [Fact]
    public async Task A_pull_stopped_at_its_time_limit_leaves_no_lock_file()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        var hook = Path.Join(lab, ".git", "hooks", "reference-transaction");
        File.WriteAllText(hook, "#!/bin/sh\n[ \"$1\" = prepared ] && sleep 5\nexit 0\n");
        File.SetUnixFileMode(hook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Api.SetNetworkTimeout(TimeSpan.FromSeconds(2));

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("Git did not finish within 2 s and was stopped.", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message);
        Assert.Empty(Directory.GetFiles(Path.Join(lab, ".git"), "*.lock", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Git_s_messages_name_the_repository_by_its_api_path()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        // A lock file a crashed git left behind: the merge refuses to start and names it.
        File.WriteAllText(Path.Join(lab, ".git", "index.lock"), "");

        var response = await PullAsync("studia/lab");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var message = (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message;
        Assert.Contains("'studia/lab/.git/index.lock'", message, StringComparison.Ordinal);
        Assert.DoesNotContain(Api.ProjectsRoot, message, StringComparison.Ordinal);
    }

    private Task<HttpResponseMessage> PullAsync(string repo) =>
        Client.Http.PostAsync($"/api/git/pull?repo={Uri.EscapeDataString(repo)}", null);
}

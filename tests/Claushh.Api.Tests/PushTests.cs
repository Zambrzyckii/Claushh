using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class PushTests(ApiFactory api) : ApiTest(api)
{
    private const UnixFileMode Executable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    public sealed record MessageBody(string Message);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Pushes_the_commits_ahead_to_the_upstream()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        Api.Git.Commit(lab, "a.txt", "a\n", "a");
        Api.Git.Commit(lab, "b.txt", "b\n", "b");

        var response = await PushAsync("studia/lab");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new MessageBody("Wypchnięto 2 commity do origin/main."), await response.Content.ReadFromJsonAsync<MessageBody>());
        Assert.Equal(Api.Git.Run(lab, "rev-parse", "HEAD"), Api.Git.Run(Api.Git.RemotePath("lab"), "rev-parse", "main"));
    }

    [Fact]
    public async Task Nothing_ahead_is_nothing_to_push_without_the_network()
    {
        Api.Git.MakeTrackedRepo("studia/lab");
        // A push would fail now; the answer must come without one.
        Directory.Delete(Api.Git.RemotePath("lab"), recursive: true);

        var response = await PushAsync("studia/lab");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new MessageBody("Nic do wypchnięcia."), await response.Content.ReadFromJsonAsync<MessageBody>());
    }

    [Fact]
    public async Task A_branch_without_an_upstream_is_pushed_to_origin_and_then_tracks_it()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        Api.Git.Run(lab, "checkout", "-q", "-b", "feature");
        Api.Git.Commit(lab, "feature.txt", "feature\n", "feature");

        var response = await PushAsync("studia/lab");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new MessageBody("Wypchnięto gałąź feature do origin/feature."), await response.Content.ReadFromJsonAsync<MessageBody>());
        Assert.Equal("origin/feature\n", Api.Git.Run(lab, "rev-parse", "--abbrev-ref", "feature@{upstream}"));
    }

    [Fact]
    public async Task Without_origin_or_on_a_detached_head_it_is_400()
    {
        Api.Git.MakeRepo("studia/local");
        var detached = Api.Git.MakeTrackedRepo("studia/detached");
        Api.Git.Run(detached, "checkout", "-q", "--detach", "HEAD");

        var local = await PushAsync("studia/local");
        var head = await PushAsync("studia/detached");

        Assert.Equal(HttpStatusCode.BadRequest, local.StatusCode);
        Assert.Equal(new MessageBody("Brak zdalnego repozytorium 'origin'."), await local.Content.ReadFromJsonAsync<MessageBody>());
        Assert.Equal(HttpStatusCode.BadRequest, head.StatusCode);
        Assert.Equal(new MessageBody("Odłączony HEAD: przełącz się na gałąź, żeby zrobić push."), await head.Content.ReadFromJsonAsync<MessageBody>());
    }

    [Fact]
    public async Task A_remote_with_newer_commits_is_409_with_the_rejection()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "theirs.txt", "theirs\n", "theirs");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Api.Git.Commit(lab, "mine.txt", "mine\n", "mine");

        var response = await PushAsync("studia/lab");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("[rejected]", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_push_the_remote_refuses_by_itself_or_cannot_reach_is_502()
    {
        var hooked = Api.Git.MakeTrackedRepo("studia/hooked");
        var hook = Path.Join(Api.Git.RemotePath("hooked"), "hooks", "pre-receive");
        File.WriteAllText(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
        File.SetUnixFileMode(hook, Executable);
        Api.Git.Commit(hooked, "a.txt", "a\n", "a");
        var gone = Api.Git.MakeTrackedRepo("studia/gone");
        Api.Git.Commit(gone, "a.txt", "a\n", "a");
        Directory.Delete(Api.Git.RemotePath("gone"), recursive: true);

        var refused = await PushAsync("studia/hooked");
        var unreachable = await PushAsync("studia/gone");

        Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
        Assert.Contains("[remote rejected]", (await refused.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.BadGateway, unreachable.StatusCode);
        Assert.Contains("fatal:", (await unreachable.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Pushing_needs_a_session_the_xsrf_token_and_a_repository()
    {
        Api.Git.MakeTrackedRepo("studia/lab");

        Assert.Equal(HttpStatusCode.Unauthorized, (await new ApiClient(Api).Http.PostAsync("/api/git/push?repo=studia%2Flab", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await PushAsync("studia/missing")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await PushAsync("studia/lab/x")).StatusCode);
        Client.SendXsrf = false;
        Assert.Equal(HttpStatusCode.BadRequest, (await PushAsync("studia/lab")).StatusCode);
    }

    private Task<HttpResponseMessage> PushAsync(string repo) =>
        Client.Http.PostAsync($"/api/git/push?repo={Uri.EscapeDataString(repo)}", null);
}

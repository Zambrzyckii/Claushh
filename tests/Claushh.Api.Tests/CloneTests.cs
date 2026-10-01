using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;

namespace Claushh.Api.Tests;

public sealed class CloneTests(ApiFactory api) : ApiTest(api)
{
    public sealed record MessageBody(string Message);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
        Directory.CreateDirectory(Api.ProjectPath("studia"));
    }

    [Fact]
    public async Task Clones_into_the_workspace_and_answers_with_the_summary()
    {
        var url = Api.Git.MakeSeededRemote("lab");

        var response = await CloneAsync("studia", url);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(new RepoListTests.RepoBody("lab", "studia/lab", "main", 0, "origin/main", 0, 0,
                new RepoListTests.CommitBody("first", "2026-09-01T10:00:00Z")),
            await response.Content.ReadFromJsonAsync<RepoListTests.RepoBody>());
        Assert.Equal("# lab\n", File.ReadAllText(Api.ProjectPath("studia/lab/README.md")));
        // git keeps the URL it was given, not the one the test configuration leads it to.
        Assert.Equal("https://git.test/lab.git\n", Api.Git.Run(Api.ProjectPath("studia/lab"), "config", "remote.origin.url"));
    }

    [Theory]
    [InlineData("https://github.com\\@evil.example/o/r.git", "Nieprawidłowy adres.")]
    [InlineData("https://github.com/o/../r", "Nieprawidłowy adres.")]
    [InlineData("https://github.com/o/./r", "Nieprawidłowy adres.")]
    [InlineData("http://github.com/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://github.com:443/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://github.com:0080/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://github.com:65536/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://127.1/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://0x7f.0.0.1/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://010.0.0.1/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://127.0.0.1./o/r", "Nieprawidłowy adres.")]
    [InlineData("https://xn--bcher-kva.example/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://github.com/o/r\n", "Nieprawidłowy adres.")]
    [InlineData("https://GitHub.com/o/r", "Nieprawidłowy adres.")]
    [InlineData("-https://github.com/o/r", "Nieprawidłowy adres.")]
    [InlineData("https://github.com/o/...git", "Nieprawidłowa nazwa katalogu.")]
    [InlineData("https://github.com/o/.git", "Nieprawidłowa nazwa katalogu.")]
    [InlineData("https://github.com/o/-x", "Nieprawidłowa nazwa katalogu.")]
    public async Task A_url_the_frontend_refuses_is_400_and_starts_no_git(string url, string message)
    {
        var response = await CloneAsync("studia", url);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new MessageBody(message), await response.Content.ReadFromJsonAsync<MessageBody>());
        Assert.Empty(Directory.GetFileSystemEntries(Api.ProjectPath("studia")));
    }

    [Fact]
    public async Task A_url_with_a_final_slash_is_accepted_as_the_frontend_does()
    {
        Api.Git.MakeSeededRemote("lab");

        Assert.Equal(HttpStatusCode.Created, (await CloneAsync("studia", "https://git.test/lab.git/")).StatusCode);
    }

    [Fact]
    public async Task An_existing_entry_is_409_and_a_workspace_that_is_not_one_is_404_or_400()
    {
        var url = Api.Git.MakeSeededRemote("lab");
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        Api.WriteProjectFile("prywatne/lab", "a file");

        var directory = await CloneAsync("studia", url);
        var file = await CloneAsync("prywatne", url);

        Assert.Equal(HttpStatusCode.Conflict, directory.StatusCode);
        Assert.Equal(new MessageBody("Katalog już istnieje."), await directory.Content.ReadFromJsonAsync<MessageBody>());
        Assert.Equal(HttpStatusCode.Conflict, file.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await CloneAsync("missing", url)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await CloneAsync("studia/lab", url)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await CloneAsync("../studia", url)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.PostAsync("/api/repos/clone", new StringContent("studia"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.PostAsJsonAsync("/api/repos/clone", new { workspace = "studia" })).StatusCode);
    }

    [Fact]
    public async Task A_remote_that_does_not_exist_is_502_with_git_s_message_and_leaves_nothing()
    {
        var response = await CloneAsync("studia", "https://git.test/missing.git");

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("fatal:", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(Api.ProjectPath("studia/missing")));
    }

    [Fact(Timeout = 60_000)]
    public async Task A_remote_that_never_answers_is_stopped_at_the_time_limit_and_leaves_nothing()
    {
        // Accepts connections and never answers: git waits for the TLS handshake until it is killed.
        using var silent = new TcpListener(IPAddress.Loopback, 0);
        silent.Start();
        var port = ((IPEndPoint)silent.LocalEndpoint).Port;
        Api.SetNetworkTimeout(TimeSpan.FromSeconds(2));
        var watch = Stopwatch.StartNew();

        var response = await CloneAsync("studia", $"https://127.0.0.1:{port}/r.git").WaitAsync(TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal(new MessageBody("Git nie skończył w ciągu 2 s i został przerwany."), await response.Content.ReadFromJsonAsync<MessageBody>());
        Assert.InRange(watch.Elapsed, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(15));
        Assert.False(Directory.Exists(Api.ProjectPath("studia/r")));
    }

    [Fact]
    public async Task Git_gets_no_transport_but_https()
    {
        // Without the test configuration's protocol.file.allow, the local remote behind https://git.test/ is refused:
        // the API's -c protocol.allow=never is in force (git's own default would allow a local path).
        var url = Api.Git.MakeSeededRemote("lab");
        Api.WriteGitConfig(allowFileTransport: false);

        var response = await CloneAsync("studia", url);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("transport 'file' not allowed", (await response.Content.ReadFromJsonAsync<MessageBody>())!.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(Api.ProjectPath("studia/lab")));
    }

    [Fact]
    public async Task Cloning_needs_a_session_and_the_xsrf_token()
    {
        var url = Api.Git.MakeSeededRemote("lab");

        Assert.Equal(HttpStatusCode.Unauthorized,
            (await new ApiClient(Api).Http.PostAsJsonAsync("/api/repos/clone", new { workspace = "studia", url })).StatusCode);
        Client.SendXsrf = false;
        Assert.Equal(HttpStatusCode.BadRequest, (await CloneAsync("studia", url)).StatusCode);
        Assert.False(Directory.Exists(Api.ProjectPath("studia/lab")));
    }

    private Task<HttpResponseMessage> CloneAsync(string workspace, string url) =>
        Client.Http.PostAsJsonAsync("/api/repos/clone", new { workspace, url });
}

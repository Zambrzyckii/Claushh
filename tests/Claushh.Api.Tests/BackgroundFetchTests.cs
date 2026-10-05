using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;

namespace Claushh.Api.Tests;

public sealed class BackgroundFetchTests(ApiFactory api) : ApiTest(api)
{
    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact(Timeout = 60_000)]
    public async Task The_list_fetches_in_the_background_at_most_every_5_minutes()
    {
        Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");

        // The list shows the state before the fetch it starts; the fetch's result shows in a later list.
        Assert.Equal(0, (await LabAsync()).Behind);
        await WaitUntilBehindAsync(1);

        Api.Clock.Advance(TimeSpan.FromMinutes(4));
        Api.Git.Commit(elsewhere, "b.txt", "b\n", "b");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        Assert.Equal(1, (await LabAsync()).Behind);
        await Task.Delay(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);
        // Not fetched: the last attempt was 4 minutes ago.
        Assert.Equal(1, (await LabAsync()).Behind);

        Api.Clock.Advance(TimeSpan.FromMinutes(1));
        await WaitUntilBehindAsync(2);
    }

    [Fact]
    public async Task A_remote_that_is_gone_does_not_break_the_list()
    {
        Api.Git.MakeTrackedRepo("studia/lab");
        Directory.Delete(Api.Git.RemotePath("lab"), recursive: true);

        Assert.Equal("studia/lab", (await LabAsync()).Path);
        await Task.Delay(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken);
        Assert.Equal("studia/lab", (await LabAsync()).Path);
    }

    [Fact(Timeout = 60_000)]
    public async Task The_list_answers_while_its_background_fetch_still_runs()
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        // A remote that never answers: the fetch would run until Git:NetworkTimeout (100 s).
        using var silent = new TcpListener(IPAddress.Loopback, 0);
        silent.Start();
        Api.Git.Run(lab, "remote", "set-url", "origin", $"https://127.0.0.1:{((IPEndPoint)silent.LocalEndpoint).Port}/lab.git");
        var watch = Stopwatch.StartNew();

        await LabAsync();
        var answered = watch.Elapsed;
        using var connection = await silent.AcceptTcpClientAsync(TestContext.Current.CancellationToken).AsTask()
            .WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        Assert.InRange(answered, TimeSpan.Zero, TimeSpan.FromSeconds(10));
        // The fetch is still connected after the answer.
        Assert.False(await ClosedWithinAsync(connection, TimeSpan.FromSeconds(1)), "the background fetch ended before its time limit");
    }

    [Theory(Timeout = 60_000)]
    [InlineData("push", "Nothing to push.")]
    [InlineData("pull", "Pulled 1 commit.")]
    public async Task A_pull_or_push_takes_the_repository_from_a_background_fetch_and_ends_its_process_tree(string operation, string message)
    {
        var lab = Api.Git.MakeTrackedRepo("studia/lab");
        var elsewhere = Api.Git.CloneElsewhere(Api.Git.RemoteUrl("lab"));
        Api.Git.Commit(elsewhere, "a.txt", "a\n", "a");
        Api.Git.Run(elsewhere, "push", "-q", "origin", "main");
        // A remote that never answers: the fetch would hold the repository for Git:NetworkTimeout (100 s).
        using var silent = new TcpListener(IPAddress.Loopback, 0);
        silent.Start();
        Api.Git.Run(lab, "remote", "set-url", "origin", $"https://127.0.0.1:{((IPEndPoint)silent.LocalEndpoint).Port}/lab.git");
        await LabAsync();
        // The fetch is running (and holds the lock) once git has connected.
        using var connection = await silent.AcceptTcpClientAsync(TestContext.Current.CancellationToken).AsTask()
            .WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        // The request's own fetch (a pull's) goes to the real remote.
        Api.Git.Run(lab, "remote", "set-url", "origin", Api.Git.RemoteUrl("lab"));
        var watch = Stopwatch.StartNew();

        var response = await Client.Http.PostAsync($"/api/git/{operation}?repo=studia%2Flab", null, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(message, (await response.Content.ReadFromJsonAsync<PushTests.MessageBody>(TestContext.Current.CancellationToken))!.Message);
        Assert.InRange(watch.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(10));
        // The fetch's whole process tree has ended: the helper that held the connection is gone.
        Assert.True(await ClosedWithinAsync(connection, TimeSpan.FromSeconds(5)), "the background fetch's connection is still open");
    }

    private async Task<RepoListTests.RepoBody> LabAsync()
    {
        var response = await Client.Http.GetAsync("/api/repos?workspace=studia", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return Assert.Single((await response.Content.ReadFromJsonAsync<List<RepoListTests.RepoBody>>())!);
    }

    // Whether the other end closes the connection within `limit`; what git sent (its TLS hello) is read first.
    private static async Task<bool> ClosedWithinAsync(TcpClient connection, TimeSpan limit)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        timeout.CancelAfter(limit);
        var buffer = new byte[4096];
        try
        {
            while (await connection.GetStream().ReadAsync(buffer, timeout.Token) > 0)
            {
            }
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (IOException)
        {
            // Reset by the other end: closed as well.
            return true;
        }
    }

    // The fetch runs in the background: the list shows its result at a later refresh.
    private async Task WaitUntilBehindAsync(int behind)
    {
        var watch = Stopwatch.StartNew();
        while ((await LabAsync()).Behind != behind)
        {
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"behind did not become {behind} within 10 s");
            await Task.Delay(TimeSpan.FromMilliseconds(100), TestContext.Current.CancellationToken);
        }
    }
}

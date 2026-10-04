using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Tests;

// /hubs/console without a process (docs/ARCHITECTURE.md, "Console"): the path guard, the conversation event, the
// stored log and its replay, the start check's config directory, and the fake CLI's recordings.
public sealed partial class ConsoleHubTests(ApiFactory api) : ApiTest(api)
{
    private static readonly string[] ProtocolWords = ["user", "assistant", "system", "result", "text"];

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    // Fixtures are hand-written or scrubbed copies of real CLI output; none may carry anything of a real run.
    [Fact]
    public void Recordings_hold_no_private_data()
    {
        var files = Directory.GetFiles(Path.Join(AppContext.BaseDirectory, "ConsoleRecordings"), "*.jsonl");

        Assert.NotEmpty(files);
        foreach (var file in files)
        {
            var text = File.ReadAllText(file);
            foreach (var forbidden in new[] { "/home/", "@", "\"usage\"", "cost", "\"account\"", "cc-socks", "signature", "rate_limit" })
            {
                Assert.DoesNotContain(forbidden, text, StringComparison.Ordinal);
            }
            Assert.DoesNotMatch(Uuid(), text);
            foreach (Match id in ApiId().Matches(text))
            {
                Assert.Matches(FixtureId(), id.Value);
            }
            if (Environment.UserName is { Length: >= 3 } user && !ProtocolWords.Contains(user))
            {
                Assert.DoesNotMatch(new Regex($@"\b{Regex.Escape(user)}\b", RegexOptions.IgnoreCase), text);
            }
            foreach (var line in File.ReadLines(file).Where(line => line.Length > 0))
            {
                using var document = JsonDocument.Parse(line);
            }
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("..")]
    [InlineData("../etc")]
    [InlineData("/etc")]
    [InlineData("studia//lab")]
    [InlineData("studia/lab/.git")]
    [InlineData("studia/file.txt")]
    [InlineData("studia/missing")]
    public async Task Refuses_what_is_not_a_directory_in_the_projects_directory(string? projectPath)
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab/.git"));
        Api.WriteProjectFile("studia/file.txt", "x");
        await using var tab = await TestConsole.ConnectAsync(Api, Client);

        var get = await Assert.ThrowsAsync<HubException>(() => tab.GetAsync(projectPath));
        var start = await Assert.ThrowsAsync<HubException>(() => tab.StartAsync(projectPath));

        Assert.EndsWith("Nieprawidłowa ścieżka", get.Message, StringComparison.Ordinal);
        Assert.EndsWith("Nieprawidłowa ścieżka", start.Message, StringComparison.Ordinal);
        Assert.Empty(tab.Events());
    }

    [Fact]
    public async Task Starting_sends_the_conversation_to_every_tab_and_stores_it_as_sent()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        await using var first = await TestConsole.ConnectAsync(Api, Client);
        await using var second = await TestConsole.ConnectAsync(Api, Client);

        var id = await first.StartAsync("studia/lab");

        var sent = await second.WaitForAsync(id, "conversation studia/lab");
        await first.WaitForAsync(id, "conversation studia/lab");
        var stored = await first.GetAsync("studia/lab");
        Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id);
        Assert.Equal(Api.Clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            sent.GetProperty("startedAt").GetString());
        Assert.Equal(id, stored.ConversationId);
        Assert.Equal(sent.GetRawText(), Assert.Single(stored.Events).GetRawText());
    }

    [Fact]
    public async Task Get_returns_the_latest_conversation_of_the_project()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        Directory.CreateDirectory(Api.ProjectPath("studia/inny"));
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        await tab.StartAsync("studia/lab");
        // StartedAt decides; the test clock stands still otherwise.
        Api.Clock.Advance(TimeSpan.FromSeconds(1));
        var latest = await tab.StartAsync("studia/lab");
        Api.Clock.Advance(TimeSpan.FromSeconds(1));
        var other = await tab.StartAsync("studia/inny");

        var lab = await tab.GetAsync("studia/lab");
        var inny = await tab.GetAsync("studia/inny");

        Assert.Equal(latest, lab.ConversationId);
        Assert.Equal(new[] { "conversation studia/lab" }, lab.Events.Select(TestConsole.Show));
        Assert.Equal(other, inny.ConversationId);
    }

    [Fact]
    public async Task A_project_without_conversations_has_none()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);

        var snapshot = await tab.GetAsync("");

        Assert.Null(snapshot.ConversationId);
        Assert.Empty(snapshot.Events);
    }

    [Fact]
    public void The_start_check_creates_the_config_directory_for_the_owner_only()
    {
        // ApiFactory gives the API a config directory that does not exist before the host starts.
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(Api.ClaudeHome));
    }

    [Fact]
    public async Task The_console_hub_connects_only_with_a_session_and_an_allowed_origin()
    {
        await using var withoutSession = TestHub.Build(Api, new ApiClient(Api), "/hubs/console");
        await using var withoutOrigin = TestHub.Build(Api, Client, "/hubs/console", origin: null);

        var noSession = await Assert.ThrowsAnyAsync<Exception>(() => withoutSession.StartAsync().WaitAsync(TimeSpan.FromSeconds(20)));
        var noOrigin = await Assert.ThrowsAnyAsync<Exception>(() => withoutOrigin.StartAsync().WaitAsync(TimeSpan.FromSeconds(20)));
        await using var tab = await TestConsole.ConnectAsync(Api, Client);

        Assert.Contains("401", noSession.ToString(), StringComparison.Ordinal);
        Assert.Contains("403", noOrigin.ToString(), StringComparison.Ordinal);
        Assert.Null((await tab.GetAsync("")).ConversationId);
    }

    [GeneratedRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")]
    private static partial Regex Uuid();

    [GeneratedRegex(@"\b(?:msg|toolu|req)_[A-Za-z0-9]+")]
    private static partial Regex ApiId();

    [GeneratedRegex("^(?:msg|toolu)_fixture[0-9]+$")]
    private static partial Regex FixtureId();
}

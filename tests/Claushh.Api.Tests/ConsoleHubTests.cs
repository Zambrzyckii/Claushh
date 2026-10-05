using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Claushh.Api.Claude;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

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

        Assert.EndsWith("Invalid path", get.Message, StringComparison.Ordinal);
        Assert.EndsWith("Invalid path", start.Message, StringComparison.Ordinal);
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

    // Console:ApiKeyFile is refused when its real path lies in the projects directory or its mode has a group or other
    // bit; a file elsewhere with mode 0600 is used, also through a symlink and next to the projects directory.
    [Theory]
    [InlineData("in the projects directory", false)]
    [InlineData("a link into the projects directory", false)]
    [InlineData("a link in the projects directory", false)]
    [InlineData("group-readable", false)]
    [InlineData("readable by others", false)]
    [InlineData("outside", true)]
    [InlineData("a link from outside", true)]
    [InlineData("next to the projects directory", true)]
    public async Task The_api_key_file_must_lie_outside_the_projects_directory_without_group_or_other_permissions(string where, bool usable)
    {
        using var outside = new OutsideDirectory();
        var sibling = Api.ProjectsRoot + "-keys";
        Directory.CreateDirectory(sibling);
        try
        {
            var path = where switch
            {
                "in the projects directory" => Key(Api.ProjectPath("keys/api-key")),
                "a link into the projects directory" => Link(outside.Child("api-key"), Key(Api.ProjectPath("keys/api-key"))),
                "a link in the projects directory" => Link(Api.ProjectPath("keys/api-key"), Key(outside.Child("api-key"))),
                "group-readable" => Key(outside.Child("api-key"), UnixFileMode.GroupRead),
                "readable by others" => Key(outside.Child("api-key"), UnixFileMode.OtherRead),
                "outside" => Key(outside.Child("api-key")),
                "a link from outside" => Link(outside.Child("link"), Key(outside.Child("api-key"))),
                _ => Key(Path.Join(sibling, "api-key")),
            };
            var cli = Api.Services.GetRequiredService<ClaudeCli>();
            Api.SetApiKeyFile(path);

            await cli.PrepareAsync(TestContext.Current.CancellationToken);

            Assert.Equal(usable, cli.Available);
        }
        finally
        {
            Directory.Delete(sibling, recursive: true);
        }
    }

    // Without its argument object a call gets the answer of empty fields.
    [Fact]
    public async Task Calls_without_their_argument_get_the_answers_of_empty_fields()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var deadline = TimeSpan.FromSeconds(20);

        var prompt = await Assert.ThrowsAsync<HubException>(() => tab.Hub.InvokeAsync("SendPrompt", (object?)null).WaitAsync(deadline));
        var answer = await Assert.ThrowsAsync<HubException>(() => tab.Hub.InvokeAsync("AnswerPermission", (object?)null).WaitAsync(deadline));
        await tab.Hub.InvokeAsync("Interrupt", (object?)null).WaitAsync(deadline);

        Assert.EndsWith("Invalid prompt", prompt.Message, StringComparison.Ordinal);
        Assert.EndsWith("Unknown decision", answer.Message, StringComparison.Ordinal);
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

    // A key file with mode 0600 plus `extra`.
    private static string Key(string path, UnixFileMode extra = UnixFileMode.None)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "test-key\n");
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | extra);
        return path;
    }

    private static string Link(string path, string target)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.CreateSymbolicLink(path, target);
        return path;
    }

    [GeneratedRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")]
    private static partial Regex Uuid();

    [GeneratedRegex(@"\b(?:msg|toolu|req)_[A-Za-z0-9]+")]
    private static partial Regex ApiId();

    [GeneratedRegex("^(?:msg|toolu)_fixture[0-9]+$")]
    private static partial Regex FixtureId();
}

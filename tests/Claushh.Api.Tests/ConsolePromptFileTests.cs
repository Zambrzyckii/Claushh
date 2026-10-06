using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Tests;

// The open file a prompt names (docs/ARCHITECTURE.md, "Console" → hub contract; "Backend" → "Console"): a note with its
// path as a second text block, never its content; the prompt event's file; the shape and place checks ("Invalid file").
public sealed class ConsolePromptFileTests(ApiFactory api) : ApiTest(api)
{
    private const string Maybe = "This may or may not be related to the current task.";

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    private static string[] Turns(int count) =>
        [.. Enumerable.Repeat(new[] { "turn-start.jsonl", "read-and-command.jsonl" }, count).SelectMany(turn => turn)];

    // The text blocks of every user line the fake received, in order.
    private IReadOnlyList<string[]> Blocks(string id) =>
    [
        .. Api.Claude.Stdin(id).Where(line => TestConsole.Str(line, "type") == "user")
            .Select(line => line.GetProperty("message").GetProperty("content").EnumerateArray()
                .Select(block => block.GetProperty("text").GetString()!).ToArray()),
    ];

    private static Task UntilTurnsAsync(TestConsole tab, string id, int turns) =>
        TestConsole.UntilAsync(() => tab.Shown(id).Count(line => line == "status idle") == turns, $"the end of turn {turns}");

    [Fact]
    public async Task The_cli_gets_the_open_file_as_a_note_with_its_path_and_lines_and_never_its_content()
    {
        Api.WriteProjectFile("studia/lab/src/main.c", "int sekret = 42;\n");
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", Turns(3));

        await tab.SendWithFileAsync(id, "popraw", new { path = "studia/lab/src/main.c" });
        await UntilTurnsAsync(tab, id, 1);
        await tab.SendWithFileAsync(id, "wyjaśnij", new { path = "studia/lab/src/main.c", startLine = 5, endLine = 10 });
        await UntilTurnsAsync(tab, id, 2);
        await tab.SendWithFileAsync(id, "a ta?", new { path = "studia/lab/src/main.c", startLine = 7, endLine = 7 });
        await UntilTurnsAsync(tab, id, 3);

        Assert.Equal(new[]
        {
            new[] { "popraw", $"The user opened the file src/main.c in the editor. {Maybe}" },
            new[] { "wyjaśnij", $"The user selected lines 5 to 10 of src/main.c in the editor. {Maybe}" },
            new[] { "a ta?", $"The user selected line 7 of src/main.c in the editor. {Maybe}" },
        }, Blocks(id));
        Assert.DoesNotContain(Api.Claude.Stdin(id), line => line.GetRawText().Contains("sekret", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_prompt_event_names_the_file_relative_to_the_conversation_and_a_replay_shows_it()
    {
        Api.WriteProjectFile("studia/lab/src/main.c", "x\n");
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", Turns(2));

        await tab.SendWithFileAsync(id, "popraw", new { path = "studia/lab/src/main.c", startLine = 5, endLine = 10 });
        await UntilTurnsAsync(tab, id, 1);
        await tab.SendAsync(id, "bez pliku");
        await UntilTurnsAsync(tab, id, 2);

        var prompts = tab.Events(id).Where(e => TestConsole.Str(e, "type") == "prompt").ToList();
        var file = prompts[0].GetProperty("file");
        Assert.Equal(new[] { "path", "startLine", "endLine" }, file.EnumerateObject().Select(property => property.Name));
        Assert.Equal("src/main.c", file.GetProperty("path").GetString());
        Assert.Equal(5, file.GetProperty("startLine").GetInt32());
        Assert.Equal(10, file.GetProperty("endLine").GetInt32());
        Assert.False(prompts[1].TryGetProperty("file", out _));
        var replay = (await tab.GetAsync("studia/lab")).Events.Where(e => TestConsole.Str(e, "type") == "prompt");
        Assert.Equal(prompts.Select(e => e.GetRawText()), replay.Select(e => e.GetRawText()));
    }

    [Fact]
    public async Task A_prompt_starting_with_a_slash_stays_client_composed_and_still_carries_the_note()
    {
        Api.WriteProjectFile("studia/lab/notes.txt", "x\n");
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", Turns(1));

        await tab.SendWithFileAsync(id, "/effort medium", new { path = "studia/lab/notes.txt" });
        await UntilTurnsAsync(tab, id, 1);

        var user = Api.Claude.Stdin(id).Single(line => TestConsole.Str(line, "type") == "user");
        Assert.True(user.GetProperty("client_composed").GetBoolean());
        Assert.Equal(new[] { new[] { "/effort medium", $"The user opened the file notes.txt in the editor. {Maybe}" } }, Blocks(id));
    }

    // "nie-id" is no conversation: the shape is checked before the conversation is looked up.
    [Theory]
    [InlineData(null, null, null)]
    [InlineData("studia/lab/a.c", 5, null)]
    [InlineData("studia/lab/a.c", null, 5)]
    [InlineData("studia/lab/a.c", 0, 3)]
    [InlineData("studia/lab/a.c", 10, 5)]
    [InlineData("studia/lab/a.c", 1, 10_000_001)]
    [InlineData("studia/lab/a\nb.c", null, null)]
    [InlineData("studia/lab/a\u007fb.c", null, null)]
    [InlineData("studia/lab/a\u0085b.c", null, null)]
    [InlineData("studia/lab/a\u2028b.c", null, null)]
    public async Task A_malformed_file_is_refused_before_the_conversation_is_looked_up(string? path, int? startLine, int? endLine)
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);

        var error = await Assert.ThrowsAsync<HubException>(() => tab.SendWithFileAsync("nie-id", "x", new { path, startLine, endLine }));

        Assert.EndsWith("Invalid file", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_file_outside_the_conversations_directory_is_refused_after_the_busy_check_and_nothing_starts()
    {
        Api.WriteProjectFile("studia/lab/src/main.c", "x\n");
        Api.WriteProjectFile("studia/other/x.c", "x\n");
        using var outside = new OutsideDirectory();
        File.WriteAllText(outside.Child("secret.c"), "x\n");
        Api.Link("studia/lab/to-other.c", Api.ProjectPath("studia/other/x.c"));
        Api.Link("studia/lab/to-secret.c", outside.Child("secret.c"));
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", TestClaude.Hang);

        // A good shape for an unknown conversation: the place is checked later.
        var unknown = await Assert.ThrowsAsync<HubException>(() =>
            tab.SendWithFileAsync(Guid.NewGuid().ToString(), "x", new { path = "studia/other/x.c" }));
        Assert.EndsWith("Unknown conversation", unknown.Message, StringComparison.Ordinal);
        foreach (var path in new[]
                 {
                     "studia/other/x.c", "studia/lab/src", "studia/lab/missing.c", "studia/lab/to-other.c",
                     "studia/lab/to-secret.c", "studia/lab/../other/x.c",
                 })
        {
            var error = await Assert.ThrowsAsync<HubException>(() => tab.SendWithFileAsync(id, "x", new { path }));
            Assert.EndsWith("Invalid file", error.Message, StringComparison.Ordinal);
        }
        Assert.Empty(Api.Claude.Launches(id));
        Assert.Equal(new[] { "conversation studia/lab" }, tab.Shown(id));

        // Still free; while its turn runs, "Conversation is busy" comes before the place.
        await tab.SendWithFileAsync(id, "popraw", new { path = "studia/lab/src/main.c" });
        await tab.WaitForAsync(id, "status working");
        var busy = await Assert.ThrowsAsync<HubException>(() => tab.SendWithFileAsync(id, "x", new { path = "studia/other/x.c" }));
        Assert.EndsWith("Conversation is busy", busy.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_link_inside_is_named_by_its_own_path_and_the_projects_directory_takes_any_file()
    {
        Api.WriteProjectFile("studia/lab/src/main.c", "x\n");
        Api.Link("studia/lab/latest.c", "src/main.c");
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var lab = await tab.StartScriptedAsync(Api, "studia/lab", Turns(1));
        var all = await tab.StartScriptedAsync(Api, "", Turns(1));

        await tab.SendWithFileAsync(lab, "popraw", new { path = "studia/lab/latest.c" });
        await UntilTurnsAsync(tab, lab, 1);
        await tab.SendWithFileAsync(all, "popraw", new { path = "studia/lab/src/main.c" });
        await UntilTurnsAsync(tab, all, 1);

        Assert.Equal($"The user opened the file latest.c in the editor. {Maybe}", Blocks(lab).Single()[1]);
        Assert.Equal($"The user opened the file studia/lab/src/main.c in the editor. {Maybe}", Blocks(all).Single()[1]);
    }
}

using Claushh.Api.Claude;
using Claushh.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

// What the console tells about files (docs/ARCHITECTURE.md, "Backend" → "Console"): edit counts from the CLI's own
// diff, files-changed for edits and for commands in a repository, the output cap, and 90-day retention.
public sealed class ConsoleFileTests(ApiFactory api) : ApiTest(api)
{
    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    private static string Edit(string toolId, string path) => TestClaude.Emit(new
    {
        type = "assistant",
        message = new { id = "msg_fixture21", content = new[] { new { type = "tool_use", id = toolId, name = "Edit", input = new { file_path = path, old_string = "a", new_string = "b" } } } },
        parent_tool_use_id = (string?)null,
    });

    private static string Edited(string toolId, string path) => TestClaude.Emit(new
    {
        type = "user",
        message = new { role = "user", content = new[] { new { tool_use_id = toolId, type = "tool_result", content = "The file has been updated successfully." } } },
        parent_tool_use_id = (string?)null,
        tool_use_result = new { filePath = path, structuredPatch = new[] { new { lines = new[] { "-a", "+b" } } } },
    });

    private static string Command(string toolId, string command) => TestClaude.Emit(new
    {
        type = "assistant",
        message = new { id = "msg_fixture22", content = new[] { new { type = "tool_use", id = toolId, name = "Bash", input = new { command } } } },
        parent_tool_use_id = (string?)null,
    });

    private static string Ran(string toolId, string stdout) => TestClaude.Emit(new
    {
        type = "user",
        message = new { role = "user", content = new[] { new { tool_use_id = toolId, type = "tool_result", content = stdout } } },
        parent_tool_use_id = (string?)null,
        tool_use_result = new { stdout, stderr = "" },
    });

    [Fact]
    public async Task An_edit_counts_its_diff_and_reports_its_file_relative_to_the_projects_directory()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "edit.jsonl");

        await tab.SendAsync(id, "popraw notatki", mode: "acceptEdits");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt popraw notatki", "status working", "step edit notes.txt +1 -1",
            "files studia/lab/notes.txt", "status idle",
        }, tab.Shown(id));
    }

    [Fact]
    public async Task A_write_counts_its_lines_when_it_creates_and_its_diff_when_it_updates()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "write-create-and-update.jsonl");

        await tab.SendAsync(id, "utwórz listę", mode: "acceptEdits");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[]
        {
            "step write lista.txt +3 -0", "files studia/lab/lista.txt", "step edit lista.txt +1 -1", "files studia/lab/lista.txt",
            "status idle",
        }, tab.Shown(id).Skip(3));
    }

    [Fact]
    public async Task Edits_outside_the_projects_directory_or_inside_git_are_not_reported()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl",
            Edit("toolu_fixture23", "/srv/elsewhere/x.txt"), Edited("toolu_fixture23", "/srv/elsewhere/x.txt"),
            Edit("toolu_fixture24", "{{cwd}}/.git/config"), Edited("toolu_fixture24", "{{cwd}}/.git/config"), TestClaude.Success);

        await tab.SendAsync(id, "popraw", mode: "acceptEdits");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[] { "step edit /srv/elsewhere/x.txt +1 -1", "step edit .git/config +1 -1", "status idle" }, tab.Shown(id).Skip(3));
    }

    [Fact]
    public async Task A_command_that_changes_files_in_a_repository_reports_them_at_the_end_of_the_turn()
    {
        Api.Git.MakeRepo("studia/lab");
        // Changed before the prompt: not this turn's change.
        Api.WriteProjectFile("studia/lab/README.md", "zmieniony\n");
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartAsync("studia/lab");
        Api.Claude.Script(id, "turn-start.jsonl", Command("toolu_fixture25", "touch nowy.txt"), TestClaude.Touch("nowy.txt"),
            Ran("toolu_fixture25", ""), TestClaude.Success);

        await tab.SendAsync(id, "utwórz plik");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[] { "step command touch nowy.txt", "files studia/lab/nowy.txt", "status idle" }, tab.Shown(id).Skip(3));
    }

    [Fact]
    public async Task A_command_outside_a_repository_reports_nothing()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia", "turn-start.jsonl", Command("toolu_fixture26", "touch nowy.txt"),
            TestClaude.Touch("nowy.txt"), Ran("toolu_fixture26", ""), TestClaude.Success);

        await tab.SendAsync(id, "utwórz plik");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[] { "step command touch nowy.txt", "status idle" }, tab.Shown(id).Skip(3));
    }

    [Fact]
    public async Task A_repository_that_a_turn_makes_reports_nothing_at_its_end()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartAsync("studia/lab");
        Api.Claude.Script(id, "turn-start.jsonl", Command("toolu_fixture31", "git init"), TestClaude.AwaitFile("init"),
            Ran("toolu_fixture31", ""), TestClaude.Success);

        await tab.SendAsync(id, "zrób repozytorium");
        await tab.WaitForAsync(id, "status working");
        Api.Git.Init("studia/lab");
        Api.WriteProjectFile("studia/lab/notatki.txt", "x\n");
        Api.Claude.Release(id, "init");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[] { "step command git init", "status idle" }, tab.Shown(id).Skip(3));
    }

    [Theory]
    [InlineData(8_000, "⟨8000 characters omitted⟩")]
    [InlineData(1, "⟨1 character omitted⟩")]
    public async Task Output_over_32000_characters_keeps_its_end_after_a_note_with_the_count(int extra, string note)
    {
        var output = new string('a', extra) + new string('b', 32_000);
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", Command("toolu_fixture27", "cat duzy.log"),
            Ran("toolu_fixture27", output), TestClaude.Success);

        await tab.SendAsync(id, "pokaż log");
        await tab.WaitForAsync(id, "status idle");

        var text = tab.Events(id).Single(e => TestConsole.Str(e, "type") == "step-output").GetProperty("text").GetString();
        Assert.Equal(note + "\n" + new string('b', 32_000), text);
    }

    [Fact]
    public async Task Conversations_idle_for_90_days_are_deleted_with_their_events_and_rules_are_kept()
    {
        string old, active;
        await using (var tab = await TestConsole.ConnectAsync(Api, Client))
        {
            old = await tab.StartScriptedAsync(Api, "a", "turn-start.jsonl", "read-and-command.jsonl");
            active = await tab.StartScriptedAsync(Api, "b", "turn-start.jsonl", "read-and-command.jsonl");
        }
        // Sessions last 30 minutes: every jump of the clock needs a new login.
        Api.Clock.Advance(TimeSpan.FromDays(80));
        await Client.LoginAsOwnerAsync();
        await using (var tab = await TestConsole.ConnectAsync(Api, Client))
        {
            await tab.SendAsync(active, "x");
            await tab.WaitForAsync(active, "status idle");
        }
        Api.Clock.Advance(TimeSpan.FromDays(11));
        await Client.LoginAsOwnerAsync();
        await using var last = await TestConsole.ConnectAsync(Api, Client);
        var fresh = await last.StartScriptedAsync(Api, "c");
        await using (var scope = Api.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
            db.ConsoleRules.Add(new ConsoleRule { ProjectPath = "a", Rule = "Bash(make *)", CreatedAt = Api.Clock.GetUtcNow() });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        await Api.Services.GetRequiredService<ConversationCleanup>().RunOnceAsync(TestContext.Current.CancellationToken);

        Assert.Null((await last.GetAsync("a")).ConversationId);
        Assert.Equal(active, (await last.GetAsync("b")).ConversationId);
        Assert.Equal(fresh, (await last.GetAsync("c")).ConversationId);
        await using var check = Api.Services.CreateAsyncScope();
        var data = check.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        Assert.False(await data.ConversationEvents.AnyAsync(e => e.ConversationId == Guid.Parse(old), TestContext.Current.CancellationToken));
        Assert.Single(await data.ConsoleRules.ToListAsync(TestContext.Current.CancellationToken));
    }
}

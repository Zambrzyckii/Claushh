using System.Net;
using System.Text.Json;
using Claushh.Api.Claude;
using Claushh.Api.Data;
using Claushh.Api.Files;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

// One claude process per conversation on the fake CLI (docs/ARCHITECTURE.md, "Backend" → "Console"): the command line
// and environment, the events of a turn, options, limits, interrupts, ends of processes, recovery and idle processes.
public sealed class ConsoleTurnTests(ApiFactory api) : ApiTest(api)
{
    private const string Settings = """{"disableAllHooks":true,"permissions":{"blockReadsOutsideWorkingDirectories":true,"allow":[]},"cleanupPeriodDays":90}""";
    private static readonly string[] Allowed =
    [
        "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS", "CLAUDE_CONFIG_DIR", "DISABLE_UPDATES", "DISABLE_AUTOUPDATER", "TERM", "DOTNET_ROOT",
    ];
    private static readonly string[] ReadAndCommand =
    [
        "step read notes.txt", "step command echo zrobione", "output zrobione", "output uwaga",
        "text msg_fixture3:1 Gotowe", "text msg_fixture3:1 . Plik ma jedną linię.", "status idle",
    ];

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    private Conversations Conversations => Api.Services.GetRequiredService<Conversations>();

    private string Real(string relative) => Path.Join(Api.Services.GetRequiredService<ProjectPaths>().Root, relative);

    [Fact]
    public async Task The_first_prompt_starts_claude_with_the_hardened_command_line_and_a_clean_environment()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        Api.Link("studia/link", Api.ProjectPath("studia/lab"));
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartAsync("studia/link");
        Api.Claude.Script(id, "turn-start.jsonl", "read-and-command.jsonl");

        await tab.SendAsync(id, "przeczytaj notatki");
        await tab.WaitForAsync(id, "status idle");

        var launch = Assert.Single(Api.Claude.Launches(id));
        string[] expected =
        [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--permission-prompt-tool", "stdio", "--restricted", "--tools",
            "Bash,Read,Edit,Write,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TaskCreate,TaskGet,TaskList,TaskUpdate,TaskStop,ToolSearch,ExitPlanMode",
            "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--settings", Settings, "--model", "haiku",
            "--effort", "low", "--permission-mode", "default", "--session-id", id,
        ];
        Assert.Equal(expected, launch.GetProperty("argv").EnumerateArray().Select(argument => argument.GetString()!));
        Assert.Equal(Real("studia/lab"), launch.GetProperty("cwd").GetString());
        var environment = launch.GetProperty("env").EnumerateObject().ToDictionary(v => v.Name, v => v.Value.GetString());
        Assert.All(environment.Keys, name => Assert.True(Allowed.Contains(name) || name.StartsWith("LC_", StringComparison.Ordinal), name));
        Assert.Equal(Api.ClaudeHome, environment["CLAUDE_CONFIG_DIR"]);
        Assert.Equal("1", environment["DISABLE_UPDATES"]);
        Assert.Equal("1", environment["DISABLE_AUTOUPDATER"]);
        Assert.Equal("dumb", environment["TERM"]);
        Assert.Equal(new[] { "initialize", "set_model haiku", "set_permission_mode default", "apply_flag_settings low", "user" },
            Api.Claude.Requests(id));
        var prompt = Api.Claude.Stdin(id)[^1];
        Assert.Equal("przeczytaj notatki", prompt.GetProperty("message").GetProperty("content")[0].GetProperty("text").GetString());
        Assert.Equal("human", prompt.GetProperty("origin").GetProperty("kind").GetString());
        Assert.True(Guid.TryParse(prompt.GetProperty("uuid").GetString(), out _));
        Assert.Equal(JsonValueKind.Null, prompt.GetProperty("parent_tool_use_id").ValueKind);
        Assert.False(prompt.TryGetProperty("client_composed", out _));
    }

    [Fact]
    public async Task A_turn_streams_its_events_in_contract_order()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-and-command.jsonl");

        await tab.SendAsync(id, "przeczytaj notatki");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[] { "conversation studia/lab", "prompt przeczytaj notatki", "status working" }.Concat(ReadAndCommand),
            tab.Shown(id));
    }

    [Fact]
    public async Task Replay_merges_text_per_message_and_equals_the_live_stream()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-and-command.jsonl");
        await tab.SendAsync(id, "przeczytaj notatki");
        await tab.WaitForAsync(id, "status idle");
        await using var later = await TestConsole.ConnectAsync(Api, Client);

        var replay = await later.GetAsync("studia/lab");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt przeczytaj notatki", "status working", "step read notes.txt",
            "step command echo zrobione", "output zrobione", "output uwaga", "text msg_fixture3:1 Gotowe. Plik ma jedną linię.",
            "status idle",
        }, replay.Events.Select(TestConsole.Show));
        Assert.Equal(tab.Events(id).Where(e => TestConsole.Str(e, "type") != "text").Select(e => e.GetRawText()),
            replay.Events.Where(e => TestConsole.Str(e, "type") != "text").Select(e => e.GetRawText()));
    }

    [Fact]
    public async Task Get_during_a_text_block_includes_the_text_so_far()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "text-interrupted.jsonl");
        await tab.SendAsync(id, "policz");
        await tab.WaitForAsync(id, "text msg_fixture9:0 , 3");

        var snapshot = await tab.GetAsync("studia/lab");

        Assert.Equal("text msg_fixture9:0 Liczę: 1, 2, 3", TestConsole.Show(snapshot.Events[^1]));
    }

    [Fact]
    public async Task A_second_prompt_reuses_the_process_and_applies_its_options_first()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab",
            "turn-start.jsonl", "read-and-command.jsonl", "turn-start.jsonl", "read-and-command.jsonl");
        await tab.SendAsync(id, "pierwsze");
        await tab.WaitForAsync(id, "status idle");

        await tab.SendAsync(id, "drugie", model: "sonnet", effort: "high", mode: "acceptEdits");
        await TestConsole.UntilAsync(() => tab.Shown(id).Count(line => line == "status idle") == 2, "the second turn's end");

        Assert.Single(Api.Claude.Launches(id));
        Assert.Equal(new[]
        {
            "initialize", "set_model haiku", "set_permission_mode default", "apply_flag_settings low", "user",
            "set_model sonnet", "set_permission_mode acceptEdits", "apply_flag_settings high", "user",
        }, Api.Claude.Requests(id));
    }

    [Fact]
    public async Task A_busy_conversation_and_an_unknown_one_are_refused()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", TestClaude.Hang);
        await tab.SendAsync(id, "pierwsze");
        await tab.WaitForAsync(id, "status working");

        var busy = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync(id, "drugie"));
        var unknown = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync(Guid.NewGuid().ToString(), "x"));
        var malformed = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync("nie-id", "x"));

        Assert.EndsWith("Rozmowa jest zajęta", busy.Message, StringComparison.Ordinal);
        Assert.EndsWith("Nieznana rozmowa", unknown.Message, StringComparison.Ordinal);
        Assert.EndsWith("Nieznana rozmowa", malformed.Message, StringComparison.Ordinal);
        Assert.Single(Api.Claude.Launches(id));
    }

    // The 100,001-character row also needs the console hub's 1 MiB message limit: with 32 KB the connection would drop.
    [Theory]
    [InlineData(0, "haiku", "low", "default", "Nieprawidłowe polecenie")]
    [InlineData(100_001, "haiku", "low", "default", "Nieprawidłowe polecenie")]
    [InlineData(1, "gpt-5", "low", "default", "Nieprawidłowe opcje")]
    [InlineData(1, "haiku", "xhigh", "default", "Nieprawidłowe opcje")]
    [InlineData(1, "haiku", "low", "bypassPermissions", "Nieprawidłowe opcje")]
    public async Task Prompts_and_options_outside_the_contract_are_refused(int length, string model, string effort, string mode, string message)
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-and-command.jsonl");

        var error = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync(id, new string('x', length), model, effort, mode));

        Assert.EndsWith(message, error.Message, StringComparison.Ordinal);
        Assert.Empty(Api.Claude.Launches(id));
        Assert.Equal(new[] { "conversation studia/lab" }, tab.Shown(id));
    }

    [Fact]
    public async Task A_prompt_of_100000_characters_is_accepted()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-and-command.jsonl");
        var text = new string('x', 100_000);

        await tab.SendAsync(id, text);
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(text, Api.Claude.Stdin(id)[^1].GetProperty("message").GetProperty("content")[0].GetProperty("text").GetString());
    }

    [Fact]
    public async Task A_prompt_starting_with_a_slash_is_sent_as_text_for_the_model()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab",
            "turn-start.jsonl", "read-and-command.jsonl", "turn-start.jsonl", "read-and-command.jsonl");

        await tab.SendAsync(id, "/effort medium");
        await tab.WaitForAsync(id, "status idle");
        await tab.SendAsync(id, "zwykłe");
        await TestConsole.UntilAsync(() => tab.Shown(id).Count(line => line == "status idle") == 2, "the second turn's end");

        var users = Api.Claude.Stdin(id).Where(line => TestConsole.Str(line, "type") == "user").ToList();
        Assert.True(users[0].GetProperty("client_composed").GetBoolean());
        Assert.False(users[1].TryGetProperty("client_composed", out _));
    }

    [Fact]
    public async Task A_tool_the_cli_refuses_by_itself_is_a_failed_step_with_its_reason()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-outside.jsonl");

        await tab.SendAsync(id, "przeczytaj plik obok");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt przeczytaj plik obok", "status working", "step other /srv/elsewhere/notes.txt",
            $"error /srv/elsewhere/notes.txt is outside {Real("studia/lab")}; --restricted confines the file tools to the working directory.",
            "status idle",
        }, tab.Shown(id));
    }

    [Fact]
    public async Task An_unknown_control_request_gets_an_error_reply()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl",
            TestClaude.Emit(new { type = "control_request", request_id = "cli-req-9", request = new { subtype = "elicitation" } }),
            TestClaude.AwaitReply("cli-req-9"), TestClaude.Success);

        await tab.SendAsync(id, "x");
        await tab.WaitForAsync(id, "status idle");

        Assert.Contains("answer cli-req-9 error", Api.Claude.Requests(id));
    }

    [Fact]
    public async Task An_interrupted_turn_ends_as_interrupted_and_the_process_takes_the_next_prompt()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab",
            "turn-start.jsonl", "text-interrupted.jsonl", "turn-start.jsonl", "read-and-command.jsonl");
        await tab.SendAsync(id, "policz");
        await tab.WaitForAsync(id, "text msg_fixture9:0 , 3");

        await tab.InterruptAsync(id);
        await tab.WaitForAsync(id, "status idle przerwano");
        await tab.SendAsync(id, "przeczytaj notatki");
        await TestConsole.UntilAsync(() => tab.Shown(id)[^1] == "status idle", "the second turn's end");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt policz", "status working", "text msg_fixture9:0 Liczę: 1, 2",
            "text msg_fixture9:0 , 3", "status idle przerwano", "prompt przeczytaj notatki", "status working",
        }.Concat(ReadAndCommand), tab.Shown(id));
        Assert.Single(Api.Claude.Launches(id));
        Assert.Equal(new[]
        {
            "initialize", "set_model haiku", "set_permission_mode default", "apply_flag_settings low", "user", "interrupt",
            "set_model haiku", "set_permission_mode default", "apply_flag_settings low", "user",
        }, Api.Claude.Requests(id));
    }

    [Fact]
    public async Task Exit_1_after_an_interrupted_turn_is_no_error_and_the_next_prompt_resumes()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab",
            "turn-start.jsonl", "text-interrupted.jsonl", TestClaude.Exit(1), "turn-start.jsonl", "read-and-command.jsonl");
        await tab.SendAsync(id, "policz");
        await tab.WaitForAsync(id, "text msg_fixture9:0 , 3");
        await tab.InterruptAsync(id);
        await tab.WaitForAsync(id, "status idle przerwano");
        await TestConsole.UntilAsync(() => !Conversations.IsRunning(id), "the end of the process");

        await tab.SendAsync(id, "dalej");
        await TestConsole.UntilAsync(() => tab.Shown(id)[^1] == "status idle", "the resumed turn's end");

        Assert.DoesNotContain(tab.Shown(id), line => line.StartsWith("status error", StringComparison.Ordinal));
        var launches = Api.Claude.Launches(id);
        Assert.Equal(2, launches.Count);
        Assert.Equal(new[] { "--resume", id }, launches[1].GetProperty("argv").EnumerateArray().Select(a => a.GetString()!).TakeLast(2));
    }

    [Fact]
    public async Task A_cli_that_ignores_the_interrupt_is_killed_after_the_timeout()
    {
        Conversations.InterruptTimeout = TimeSpan.FromSeconds(1);
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl",
            TestClaude.Emit(new { type = "stream_event", @event = new { type = "message_start", message = new { id = "msg_fixture20" } }, parent_tool_use_id = (string?)null }),
            TestClaude.Emit(new { type = "stream_event", @event = new { type = "content_block_delta", index = 0, delta = new { type = "text_delta", text = "Liczę" } }, parent_tool_use_id = (string?)null }),
            TestClaude.Hang);
        await tab.SendAsync(id, "policz");
        await tab.WaitForAsync(id, "text msg_fixture20:0 Liczę");

        await tab.InterruptAsync(id);

        await tab.WaitForAsync(id, "status idle przerwano");
        await TestConsole.UntilAsync(() => !Conversations.IsRunning(id), "the killed process");
        Assert.Equal("interrupt", Api.Claude.Requests(id)[^1]);
    }

    [Fact]
    public async Task Interrupt_of_an_idle_or_unknown_conversation_does_nothing()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-and-command.jsonl");
        await tab.InterruptAsync(id);
        await tab.SendAsync(id, "x");
        await tab.WaitForAsync(id, "status idle");

        await tab.InterruptAsync(id);
        await tab.InterruptAsync(Guid.NewGuid().ToString());
        await tab.InterruptAsync("nie-id");
        await Task.Delay(300, TestContext.Current.CancellationToken);

        Assert.DoesNotContain("interrupt", Api.Claude.Requests(id));
        Assert.Equal("status idle", tab.Shown(id)[^1]);
    }

    [Fact]
    public async Task A_process_that_exits_during_a_turn_ends_it_with_an_error()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", TestClaude.Exit(3));

        await tab.SendAsync(id, "x");

        await tab.WaitForAsync(id, "status error Proces konsoli zakończył się (kod 3).");
        Assert.Equal(new[] { "conversation studia/lab", "prompt x", "status working", "status error Proces konsoli zakończył się (kod 3)." },
            tab.Shown(id));
    }

    [Fact]
    public async Task A_resume_that_fails_is_reported_and_the_call_fails()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab",
            "turn-start.jsonl", "read-and-command.jsonl", TestClaude.Exit(0), TestClaude.Exit(1));
        await tab.SendAsync(id, "pierwsze");
        await tab.WaitForAsync(id, "status idle");
        await TestConsole.UntilAsync(() => !Conversations.IsRunning(id), "the end of the first process");

        var error = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync(id, "drugie"));

        Assert.EndsWith("Konsola niedostępna", error.Message, StringComparison.Ordinal);
        await tab.WaitForAsync(id, "status error Nie udało się wznowić rozmowy. Zacznij nową („Nowa”).");
        Assert.Equal("--resume", Api.Claude.Launches(id)[1].GetProperty("argv").EnumerateArray().Select(a => a.GetString()).ToList()[^2]);
    }

    [Fact]
    public async Task Recovery_ends_a_turn_a_stopped_api_left_open()
    {
        var cutOff = Guid.NewGuid();
        var finished = Guid.NewGuid();
        var question = Guid.NewGuid().ToString("D");
        await using (var scope = Api.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
            var now = Api.Clock.GetUtcNow();
            db.Conversations.Add(new Conversation { Id = cutOff, ProjectPath = "studia/lab", StartedAt = now, LastEventAt = now, Resumable = true });
            db.Conversations.Add(new Conversation { Id = finished, ProjectPath = "studia/inny", StartedAt = now, LastEventAt = now });
            var key = cutOff.ToString("D");
            object[] events =
            [
                new { type = "conversation", conversationId = key, projectPath = "studia/lab", startedAt = "2026-10-04T10:00:00.000Z" },
                new { type = "prompt", conversationId = key, text = "zrób commit" },
                new { type = "status", conversationId = key, state = "working" },
                new { type = "permission", conversationId = key, requestId = question, description = "git commit -m x" },
                new { type = "status", conversationId = key, state = "waiting" },
            ];
            for (var seq = 0; seq < events.Length; seq++)
            {
                db.ConversationEvents.Add(new ConversationEvent { ConversationId = cutOff, Seq = seq + 1, Json = JsonSerializer.Serialize(events[seq]) });
            }
            var other = finished.ToString("D");
            db.ConversationEvents.Add(new ConversationEvent { ConversationId = finished, Seq = 1, Json = JsonSerializer.Serialize(new { type = "conversation", conversationId = other, projectPath = "studia/inny", startedAt = "2026-10-04T10:00:00.000Z" }) });
            db.ConversationEvents.Add(new ConversationEvent { ConversationId = finished, Seq = 2, Json = JsonSerializer.Serialize(new { type = "status", conversationId = other, state = "idle" }) });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        Directory.CreateDirectory(Api.ProjectPath("studia/inny"));
        await using var tab = await TestConsole.ConnectAsync(Api, Client);

        await Conversations.RecoverAsync();

        var replay = await tab.GetAsync("studia/lab");
        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt zrób commit", "status working", "permission git commit -m x", "status waiting",
            "resolved deny", "status error Serwer został zatrzymany w trakcie pracy.",
        }, replay.Events.Select(TestConsole.Show));
        Assert.Equal(new[] { "resolved deny", "status error Serwer został zatrzymany w trakcie pracy." }, tab.Shown(cutOff.ToString("D")));
        Assert.Equal(2, (await tab.GetAsync("studia/inny")).Events.Length);
    }

    [Fact]
    public async Task A_ninth_process_closes_the_least_recently_used_idle_one_and_with_eight_busy_another_is_refused()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var ids = new List<string>();
        for (var i = 0; i < 9; i++)
        {
            // The first finishes its turn and stays idle; the others keep theirs open.
            string[] script = i == 0 ? ["turn-start.jsonl", "read-and-command.jsonl"] : ["turn-start.jsonl", TestClaude.Hang];
            ids.Add(await tab.StartScriptedAsync(Api, $"p{i}", script));
            await tab.SendAsync(ids[i], "start");
            await tab.WaitForAsync(ids[i], i == 0 ? "status idle" : "status working");
        }
        await Api.Claude.WaitForLogAsync(ids[0], "eof");
        var tenth = await tab.StartScriptedAsync(Api, "p9", "turn-start.jsonl", TestClaude.Hang);

        var error = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync(tenth, "start"));

        Assert.EndsWith("Za dużo aktywnych rozmów", error.Message, StringComparison.Ordinal);
        Assert.False(Conversations.IsRunning(ids[0]));
        Assert.All(ids.Skip(1), id => Assert.True(Conversations.IsRunning(id), id));
        Assert.Empty(Api.Claude.Launches(tenth));
    }

    [Fact]
    public async Task An_idle_process_is_closed_after_15_minutes_and_the_next_prompt_resumes()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab",
            "turn-start.jsonl", "read-and-command.jsonl", "turn-start.jsonl", "read-and-command.jsonl");
        await tab.SendAsync(id, "pierwsze");
        await tab.WaitForAsync(id, "status idle");
        await Conversations.CloseIdleAsync();
        Assert.True(Conversations.IsRunning(id));

        Api.Clock.Advance(Conversations.IdleTimeout);
        await Conversations.CloseIdleAsync();
        await Api.Claude.WaitForLogAsync(id, "exit");
        await tab.SendAsync(id, "drugie");
        await TestConsole.UntilAsync(() => tab.Shown(id).Count(line => line == "status idle") == 2, "the resumed turn's end");

        var launches = Api.Claude.Launches(id);
        Assert.Equal(2, launches.Count);
        Assert.Equal(new[] { "--resume", id }, launches[1].GetProperty("argv").EnumerateArray().Select(a => a.GetString()!).TakeLast(2));
    }

    [Fact]
    public async Task With_an_old_cli_prompts_are_refused_while_get_and_start_still_work()
    {
        var cli = Api.Services.GetRequiredService<ClaudeCli>();
        Api.Claude.Version("2.0.0 (Claude Code)");
        await cli.PrepareAsync(TestContext.Current.CancellationToken);
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "read-and-command.jsonl");

        var error = await Assert.ThrowsAsync<HubException>(() => tab.SendAsync(id, "x"));

        Assert.False(cli.Available);
        Assert.EndsWith("Konsola niedostępna", error.Message, StringComparison.Ordinal);
        Assert.Equal(id, (await tab.GetAsync("studia/lab")).ConversationId);
        Assert.Empty(Api.Claude.Launches(id));
    }

    [Fact]
    public async Task Logout_during_a_turn_closes_the_connection_and_the_turn_goes_on()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", TestClaude.AwaitFile("go"), "read-and-command.jsonl");
        var closed = TestHub.WhenClosed(tab.Hub);
        await tab.SendAsync(id, "przeczytaj notatki");
        await tab.WaitForAsync(id, "status working");

        Assert.Equal(HttpStatusCode.NoContent, (await Client.Http.PostAsync("/api/auth/logout", null)).StatusCode);
        await closed.WaitAsync(TimeSpan.FromSeconds(5));
        Api.Claude.Release(id, "go");
        await Client.LoginAsOwnerAsync();
        await using var again = await TestConsole.ConnectAsync(Api, Client);
        await TestConsole.UntilAsync(async () => TestConsole.Show((await again.GetAsync("studia/lab")).Events[^1]) == "status idle",
            "the turn's end in the replay");

        var replay = await again.GetAsync("studia/lab");
        Assert.Equal(new[] { "conversation studia/lab", "prompt przeczytaj notatki", "status working" }
            .Concat(ReadAndCommand.Take(4)).Append("text msg_fixture3:1 Gotowe. Plik ma jedną linię.").Append("status idle"),
            replay.Events.Select(TestConsole.Show));
    }
}

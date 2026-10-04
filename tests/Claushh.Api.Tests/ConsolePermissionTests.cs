using System.Text.Json;
using System.Text.Json.Nodes;
using Claushh.Api.Claude;
using Claushh.Api.Data;
using Claushh.Api.Files;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

// The CLI's questions on the fake (docs/ARCHITECTURE.md, "Backend" → "Console"): what a question shows, the answers the
// CLI gets, "always" rules, plan approval, and questions that end without an answer.
public sealed class ConsolePermissionTests(ApiFactory api) : ApiTest(api)
{
    private const string Question = "permission git init demo [Bash(git init *)]";
    private const string Input = """{"command":"git init demo","description":"Initialize a new git repository in a demo directory"}""";

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    private Conversations Conversations => Api.Services.GetRequiredService<Conversations>();

    private string Real(string relative) => Path.Join(Api.Services.GetRequiredService<ProjectPaths>().Root, relative);

    // The one control_response the fake received.
    private JsonElement Answer(string id) =>
        Api.Claude.Stdin(id).Single(line => TestConsole.Str(line, "type") == "control_response").GetProperty("response");

    [Fact]
    public async Task A_bash_question_shows_the_exact_command_and_its_rule_then_waits()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.AwaitReply("cli-req-1"), "bash-allowed.jsonl");

        await tab.SendAsync(id, "zainicjuj repozytorium");
        var question = await tab.WaitForAsync(id, Question);
        await tab.WaitForAsync(id, "status waiting");

        Assert.True(Guid.TryParseExact(question.GetProperty("requestId").GetString(), "D", out _));
        Assert.Equal(new[] { "conversation studia/lab", "prompt zainicjuj repozytorium", "status working", Question, "status waiting" },
            tab.Shown(id));
    }

    [Fact]
    public async Task Deny_is_resolved_written_and_the_turn_works_on()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.AwaitReply("cli-req-1"), "bash-denied.jsonl");
        await tab.SendAsync(id, "zainicjuj repozytorium");
        var question = await tab.WaitForAsync(id, Question);

        await tab.AnswerAsync(id, question.GetProperty("requestId").GetString()!, "deny");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt zainicjuj repozytorium", "status working", Question, "status waiting",
            "resolved deny", "status working", "status idle",
        }, tab.Shown(id));
        var answer = Answer(id);
        Assert.Equal("cli-req-1", answer.GetProperty("request_id").GetString());
        Assert.Equal("""{"behavior":"deny","message":"The user denied this action."}""", answer.GetProperty("response").GetRawText());
    }

    [Fact]
    public async Task Allow_resolves_the_question_before_the_step_and_passes_the_input_back()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.AwaitReply("cli-req-1"), "bash-allowed.jsonl");
        await tab.SendAsync(id, "zainicjuj repozytorium");
        var question = await tab.WaitForAsync(id, Question);

        await tab.AnswerAsync(id, question.GetProperty("requestId").GetString()!, "allow");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt zainicjuj repozytorium", "status working", Question, "status waiting",
            "resolved allow", "status working", "step command git init demo",
            $"output Initialized empty Git repository in {Real("studia/lab")}/demo/.git/", "status idle",
        }, tab.Shown(id));
        var response = Answer(id).GetProperty("response");
        Assert.Equal("allow", response.GetProperty("behavior").GetString());
        Assert.Equal(Input, response.GetProperty("updatedInput").GetRawText());
        Assert.False(response.TryGetProperty("updatedPermissions", out _));
    }

    [Fact]
    public async Task Allow_always_saves_exactly_the_shown_rule_and_passes_it_to_the_next_launch()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.AwaitReply("cli-req-1"), "bash-allowed.jsonl", TestClaude.Exit(0), "turn-start.jsonl", "read-and-command.jsonl");
        await tab.SendAsync(id, "zainicjuj repozytorium");
        var question = await tab.WaitForAsync(id, Question);

        await tab.AnswerAsync(id, question.GetProperty("requestId").GetString()!, "allow-always");
        await tab.WaitForAsync(id, "status idle");
        await TestConsole.UntilAsync(() => !Conversations.IsRunning(id), "the end of the first process");
        await tab.SendAsync(id, "dalej");
        await TestConsole.UntilAsync(() => tab.Shown(id)[^1] == "status idle", "the resumed turn's end");

        Assert.Contains("resolved allow-always", tab.Shown(id));
        Assert.Equal("""[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"git init *"}],"behavior":"allow","destination":"session"}]""",
            Answer(id).GetProperty("response").GetProperty("updatedPermissions").GetRawText());
        await using var scope = Api.Services.CreateAsyncScope();
        var rule = await scope.ServiceProvider.GetRequiredService<ClaushhDbContext>().ConsoleRules.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(("studia/lab", "Bash(git init *)"), (rule.ProjectPath, rule.Rule));
        var argv = Api.Claude.Launches(id)[1].GetProperty("argv").EnumerateArray().Select(a => a.GetString()!).ToList();
        var settings = JsonNode.Parse(argv[argv.IndexOf("--settings") + 1])!;
        Assert.Equal("""["Bash(git init *)"]""", settings["permissions"]!["allow"]!.ToJsonString());
        Assert.Equal("--resume", argv[^2]);
    }

    [Fact]
    public async Task A_write_question_names_the_relative_path_and_cannot_be_allowed_always()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "write-question.jsonl");
        await tab.SendAsync(id, "utwórz plik");
        var question = await tab.WaitForAsync(id, "permission created.txt");
        var requestId = question.GetProperty("requestId").GetString()!;

        var refused = await Assert.ThrowsAsync<HubException>(() => tab.AnswerAsync(id, requestId, "allow-always"));
        await tab.AnswerAsync(id, requestId, "allow");
        await tab.WaitForAsync(id, "status idle");

        Assert.EndsWith("To pytanie nie ma reguły do zapisania", refused.Message, StringComparison.Ordinal);
        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt utwórz plik", "status working", "permission created.txt", "status waiting",
            "resolved allow", "status working",
        }, tab.Shown(id).Take(7));
        Assert.Equal("allow", Answer(id).GetProperty("response").GetProperty("behavior").GetString());
    }

    [Fact]
    public async Task An_unknown_decision_is_refused_and_unknown_requests_are_silent()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.AwaitReply("cli-req-1"), "bash-allowed.jsonl");
        await tab.SendAsync(id, "zainicjuj repozytorium");
        var requestId = (await tab.WaitForAsync(id, Question)).GetProperty("requestId").GetString()!;

        var maybe = await Assert.ThrowsAsync<HubException>(() => tab.AnswerAsync(id, requestId, "maybe"));
        var first = await Assert.ThrowsAsync<HubException>(() => tab.AnswerAsync("nie-id", "x", "tak"));
        await tab.AnswerAsync(id, Guid.NewGuid().ToString(), "allow");
        await tab.AnswerAsync(Guid.NewGuid().ToString(), requestId, "allow");

        Assert.EndsWith("Nieznana decyzja", maybe.Message, StringComparison.Ordinal);
        Assert.EndsWith("Nieznana decyzja", first.Message, StringComparison.Ordinal);
        Assert.Equal("status waiting", tab.Shown(id)[^1]);
        Assert.DoesNotContain(Api.Claude.Requests(id), line => line.StartsWith("answer", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Two_tabs_see_the_question_and_the_first_answer_wins()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        await using var second = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.AwaitReply("cli-req-1"), "bash-denied.jsonl");
        await tab.SendAsync(id, "zainicjuj repozytorium");
        var requestId = (await second.WaitForAsync(id, Question)).GetProperty("requestId").GetString()!;

        await second.AnswerAsync(id, requestId, "deny");
        await tab.AnswerAsync(id, requestId, "allow");
        await tab.WaitForAsync(id, "status idle");
        await second.WaitForAsync(id, "status idle");

        Assert.Equal("resolved deny", Assert.Single(tab.Shown(id), line => line.StartsWith("resolved", StringComparison.Ordinal)));
        Assert.Equal(tab.Shown(id), second.Shown(id));
        Assert.Equal("deny", Answer(id).GetProperty("response").GetProperty("behavior").GetString());
    }

    [Fact]
    public async Task Several_suggested_rules_offer_no_rule()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "outside-read-question.jsonl");
        await tab.SendAsync(id, "pokaż nazwę hosta");

        var question = await tab.WaitForAsync(id, "permission cat /etc/hostname");
        await tab.AnswerAsync(id, question.GetProperty("requestId").GetString()!, "deny");
        await tab.WaitForAsync(id, "status idle");

        Assert.False(question.TryGetProperty("alwaysRule", out _));
    }

    [Fact]
    public async Task Exit_plan_mode_shows_the_plan_and_allow_switches_back_to_asking()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "exit-plan-mode.jsonl");
        await tab.SendAsync(id, "zaplanuj plik", mode: "plan");

        var question = await tab.WaitForAsync(id, "permission # Plan\n\n1. Create plan.txt with the text hi.\n");
        await tab.AnswerAsync(id, question.GetProperty("requestId").GetString()!, "allow");
        await tab.WaitForAsync(id, "status idle");

        Assert.False(question.TryGetProperty("alwaysRule", out _));
        var response = Answer(id).GetProperty("response");
        Assert.Equal("""[{"type":"setMode","mode":"default","destination":"session"}]""", response.GetProperty("updatedPermissions").GetRawText());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(response.GetProperty("updatedInput").GetRawText()),
            JsonNode.Parse("""{"plan":"# Plan\n\n1. Create plan.txt with the text hi.\n","planFilePath":"/srv/claude-config/plans/plan-fixture.md"}""")));
        Assert.DoesNotContain(tab.Shown(id), line => line.StartsWith("step", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Interrupt_with_a_pending_question_denies_it_at_once_then_ends_as_interrupted()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl", "question-interrupted.jsonl");
        await tab.SendAsync(id, "zainicjuj repozytorium");
        await tab.WaitForAsync(id, "status waiting");

        await tab.InterruptAsync(id);
        await tab.WaitForAsync(id, "status idle przerwano");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt zainicjuj repozytorium", "status working", Question, "status waiting",
            "resolved deny", "status idle przerwano",
        }, tab.Shown(id));
        Assert.Contains("interrupt", Api.Claude.Requests(id));
        Assert.DoesNotContain(Api.Claude.Requests(id), line => line.StartsWith("answer", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_process_that_exits_with_a_pending_question_denies_it_and_reports_the_exit()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl", TestClaude.Exit(2));

        await tab.SendAsync(id, "zainicjuj repozytorium");
        await tab.WaitForAsync(id, "status error Proces konsoli zakończył się (kod 2).");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt zainicjuj repozytorium", "status working", Question, "status waiting",
            "resolved deny", "status error Proces konsoli zakończył się (kod 2).",
        }, tab.Shown(id));
    }

    [Fact]
    public async Task The_cli_withdrawing_a_question_resolves_it_as_denied()
    {
        await using var tab = await TestConsole.ConnectAsync(Api, Client);
        var id = await tab.StartScriptedAsync(Api, "studia/lab", "turn-start.jsonl", "bash-question.jsonl",
            TestClaude.Emit(new { type = "control_cancel_request", request_id = "cli-req-1" }), TestClaude.Success);

        await tab.SendAsync(id, "zainicjuj repozytorium");
        await tab.WaitForAsync(id, "status idle");

        Assert.Equal(new[]
        {
            "conversation studia/lab", "prompt zainicjuj repozytorium", "status working", Question, "status waiting",
            "resolved deny", "status working", "status idle",
        }, tab.Shown(id));
    }
}

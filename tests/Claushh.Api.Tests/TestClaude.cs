// The fake claude CLI of the tests (tests/Claushh.FakeClaude; docs/ARCHITECTURE.md, "Tests"): writes a conversation's
// script from the recordings in ConsoleRecordings/ and inline steps, and reads back what the API sent the fake.
using System.Text.Json;

namespace Claushh.Api.Tests;

public sealed class TestClaude(string home)
{
    // A turn that ends at once, as the CLI's result line.
    public static readonly string Success = Emit(new { type = "result", subtype = "success", is_error = false, result = "Gotowe." });
    public const string Hang = """{"hang":true}""";

    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(20);

    public string Folder => Path.Join(home, "fake");

    // Recordings (names ending in .jsonl) and inline steps, in order.
    public void Script(string conversationId, params string[] parts)
    {
        var lines = new List<string>();
        foreach (var part in parts)
        {
            if (part.EndsWith(".jsonl", StringComparison.Ordinal))
            {
                lines.AddRange(File.ReadAllLines(Path.Join(AppContext.BaseDirectory, "ConsoleRecordings", part)).Where(line => line.Length > 0));
            }
            else
            {
                lines.Add(part);
            }
        }
        Directory.CreateDirectory(Folder);
        File.WriteAllLines(Path.Join(Folder, conversationId + ".jsonl"), lines);
    }

    public static string Emit(object line) => JsonSerializer.Serialize(new { emit = line });

    public static string Exit(int code) => JsonSerializer.Serialize(new { exit = code });

    public static string AwaitReply(string requestId) => JsonSerializer.Serialize(new { @await = "control_response", request_id = requestId });

    public static string AwaitFile(string name) => JsonSerializer.Serialize(new { @await = "file", name });

    public static string Touch(string path) => JsonSerializer.Serialize(new { touch = path });

    // Lets a script waiting for AwaitFile(name) go on.
    public void Release(string conversationId, string name) => File.WriteAllText(Path.Join(Folder, $"{conversationId}.{name}"), "");

    public void Version(string text) => File.WriteAllText(Path.Join(Folder, "version"), text);

    // Everything the fake logged for the conversation, in order; a line still being written is skipped.
    public IReadOnlyList<JsonElement> Log(string conversationId)
    {
        var path = Path.Join(Folder, conversationId + ".log.jsonl");
        if (!File.Exists(path))
        {
            return [];
        }
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        var entries = new List<JsonElement>();
        while (reader.ReadLine() is { } line)
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                entries.Add(document.RootElement.Clone());
            }
            catch (JsonException)
            {
            }
        }
        return entries;
    }

    public IReadOnlyList<JsonElement> Launches(string conversationId) =>
        [.. Log(conversationId).Where(entry => entry.TryGetProperty("launch", out _)).Select(entry => entry.GetProperty("launch"))];

    public IReadOnlyList<JsonElement> Stdin(string conversationId) =>
        [.. Log(conversationId).Where(entry => entry.TryGetProperty("stdin", out _)).Select(entry => entry.GetProperty("stdin"))];

    // What the API sent, one short line each: "<request> [value]", "user", or "answer <request id> <behavior or subtype>".
    public IReadOnlyList<string> Requests(string conversationId) => [.. Stdin(conversationId).Select(Describe)];

    public async Task WaitForLogAsync(string conversationId, string entry)
    {
        var deadline = DateTime.UtcNow + Deadline;
        while (!Log(conversationId).Any(line => line.TryGetProperty(entry, out _)))
        {
            Assert.True(DateTime.UtcNow < deadline, $"No \"{entry}\" in the fake's log of {conversationId} within 20 s.");
            await Task.Delay(20);
        }
    }

    // Before every test (ApiFactory.ResetAsync), once no fake runs.
    public void Reset()
    {
        if (Directory.Exists(Folder))
        {
            Directory.Delete(Folder, recursive: true);
        }
        Directory.CreateDirectory(Folder);
    }

    private static string Describe(JsonElement line)
    {
        var type = TestConsole.Str(line, "type");
        if (type == "control_request")
        {
            var request = line.GetProperty("request");
            return TestConsole.Str(request, "subtype") switch
            {
                "set_model" => $"set_model {TestConsole.Str(request, "model")}",
                "set_permission_mode" => $"set_permission_mode {TestConsole.Str(request, "mode")}",
                "apply_flag_settings" => $"apply_flag_settings {TestConsole.Str(request.GetProperty("settings"), "effortLevel")}",
                var subtype => subtype ?? "?",
            };
        }
        if (type == "control_response")
        {
            var response = line.GetProperty("response");
            var behavior = response.TryGetProperty("response", out var body) ? TestConsole.Str(body, "behavior") : null;
            return $"answer {TestConsole.Str(response, "request_id")} {behavior ?? TestConsole.Str(response, "subtype")}";
        }
        return type ?? "?";
    }
}

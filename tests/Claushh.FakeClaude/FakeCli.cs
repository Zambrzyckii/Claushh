// A stand-in for the claude CLI in the backend tests (docs/ARCHITECTURE.md, "Tests"): no model and no network. It
// replays a script of stream-json lines and logs what the API sent it. Its files are in $CLAUDE_CONFIG_DIR/fake/:
// - <session>.jsonl, the conversation's script, one step per line, shared by every launch of the session
//   (<session>.cursor keeps the next step, so a resumed process goes on where the last one stopped);
// - <session>.log.jsonl, each launch (argv, working directory, environment), every stdin line, the end of stdin and
//   the exit;
// - version, the answer to --version (default "2.1.285 (Claude Code)").
// Steps: {"emit":<line>} ({{cwd}} and {{session}} replaced), {"await":"user"}, {"await":"interrupt"} (answered),
// {"await":"control_response","request_id":<id>}, {"await":"eof"}, {"await":"file","name":<n>} (until
// <session>.<n> exists), {"touch":<path in the working directory>}, {"exit":<code>}, {"hang":true}. Stdin is read
// from the first await on, so a script that starts with exit ends before it answers initialize. initialize,
// set_model, set_permission_mode and apply_flag_settings are answered as they arrive; interrupt only by its await.
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Claushh.FakeClaude;

internal static class FakeCli
{
    private static readonly object Gate = new();
    private static readonly object Writing = new();
    private static readonly object Logging = new();
    private static readonly List<JsonElement> Received = [];
    private static readonly HashSet<int> Taken = [];
    private static readonly SemaphoreSlim Arrived = new(0);
    private static readonly Stream Output = Console.OpenStandardOutput();
    private static bool _ended;
    private static Task? _reader;
    private static string _fake = "";
    private static string _session = "none";

    private static async Task<int> Main(string[] args)
    {
        _fake = Path.Join(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? ".", "fake");
        if (args is ["--version"])
        {
            var version = Path.Join(_fake, "version");
            Console.WriteLine(File.Exists(version) ? File.ReadAllText(version).Trim() : "2.1.285 (Claude Code)");
            return 0;
        }
        _session = ValueAfter(args, "--session-id") ?? ValueAfter(args, "--resume") ?? "none";
        Directory.CreateDirectory(_fake);
        var cwd = Environment.CurrentDirectory;
        Log(new JsonObject { ["launch"] = new JsonObject { ["argv"] = Strings(args), ["cwd"] = cwd, ["env"] = Variables() } });
        var cursorPath = Path.Join(_fake, _session + ".cursor");
        var scriptPath = Path.Join(_fake, _session + ".jsonl");
        var cursor = File.Exists(cursorPath) ? int.Parse(File.ReadAllText(cursorPath), CultureInfo.InvariantCulture) : 0;
        string[] steps = File.Exists(scriptPath) ? [.. File.ReadAllLines(scriptPath).Where(line => line.Length > 0)] : [];
        for (; cursor < steps.Length; cursor++)
        {
            using var document = JsonDocument.Parse(steps[cursor]);
            var step = document.RootElement;
            if (step.TryGetProperty("hang", out _))
            {
                await Task.Delay(Timeout.Infinite);
            }
            if (step.TryGetProperty("exit", out var code))
            {
                Save(cursorPath, cursor + 1);
                return Exit(code.GetInt32());
            }
            if (step.TryGetProperty("emit", out var line))
            {
                Write(line.GetRawText().Replace("{{cwd}}", JsonEncodedText.Encode(cwd).ToString(), StringComparison.Ordinal)
                    .Replace("{{session}}", _session, StringComparison.Ordinal));
            }
            else if (step.TryGetProperty("touch", out var path))
            {
                File.WriteAllText(Path.Join(cwd, path.GetString()), "nowy\n");
            }
            else if (step.TryGetProperty("await", out var what) && !await AwaitAsync(what.GetString() ?? "", step))
            {
                // Stdin ended first: the next launch starts at this step again.
                return Exit(0);
            }
            Save(cursorPath, cursor + 1);
        }
        await AwaitAsync("eof", default);
        return Exit(0);
    }

    // Waits for the first line not taken yet that the step waits for, and takes it; false when stdin ends first.
    private static async Task<bool> AwaitAsync(string kind, JsonElement step)
    {
        _reader ??= Task.Run(ReadAsync);
        if (kind == "file")
        {
            var name = Path.Join(_fake, $"{_session}.{Text(step, "name")}");
            while (!File.Exists(name))
            {
                await Task.Delay(50);
            }
            return true;
        }
        while (true)
        {
            JsonElement? found = null;
            lock (Gate)
            {
                for (var i = 0; i < Received.Count && found is null; i++)
                {
                    if (!Taken.Contains(i) && Matches(kind, Received[i], step))
                    {
                        Taken.Add(i);
                        found = Received[i];
                    }
                }
                if (found is null && _ended)
                {
                    return kind == "eof";
                }
            }
            if (found is { } request)
            {
                if (kind == "interrupt")
                {
                    Reply(request, new JsonObject { ["still_queued"] = new JsonArray() });
                }
                return true;
            }
            await Arrived.WaitAsync();
        }
    }

    // Every stdin line is logged; the requests the CLI answers at once are answered here, the rest wait for a step.
    private static async Task ReadAsync()
    {
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        while (await input.ReadLineAsync() is { } text)
        {
            JsonElement line;
            try
            {
                using var document = JsonDocument.Parse(text);
                line = document.RootElement.Clone();
            }
            catch (JsonException)
            {
                Log(new JsonObject { ["stdin_text"] = text });
                continue;
            }
            Log(new JsonObject { ["stdin"] = JsonNode.Parse(text) });
            if (Text(line, "type") == "control_request" && line.TryGetProperty("request", out var request)
                && Text(request, "subtype") is "initialize" or "set_model" or "set_permission_mode" or "apply_flag_settings")
            {
                Reply(line, null);
                continue;
            }
            lock (Gate)
            {
                Received.Add(line);
            }
            Arrived.Release();
        }
        Log(new JsonObject { ["eof"] = true });
        lock (Gate)
        {
            _ended = true;
        }
        Arrived.Release();
    }

    private static bool Matches(string kind, JsonElement line, JsonElement step) => kind switch
    {
        "user" => Text(line, "type") == "user",
        "interrupt" => Text(line, "type") == "control_request" && line.TryGetProperty("request", out var request)
            && Text(request, "subtype") == "interrupt",
        "control_response" => Text(line, "type") == "control_response" && line.TryGetProperty("response", out var response)
            && Text(response, "request_id") == Text(step, "request_id"),
        _ => false,
    };

    private static void Reply(JsonElement request, JsonNode? response)
    {
        var body = new JsonObject { ["subtype"] = "success", ["request_id"] = Text(request, "request_id") };
        if (response is not null)
        {
            body["response"] = response;
        }
        Write(new JsonObject { ["type"] = "control_response", ["response"] = body }.ToJsonString());
    }

    private static void Write(string line)
    {
        var bytes = Encoding.UTF8.GetBytes(line + "\n");
        lock (Writing)
        {
            Output.Write(bytes);
            Output.Flush();
        }
    }

    private static void Log(JsonObject entry)
    {
        lock (Logging)
        {
            File.AppendAllText(Path.Join(_fake, _session + ".log.jsonl"), entry.ToJsonString() + "\n");
        }
    }

    private static int Exit(int code)
    {
        Log(new JsonObject { ["exit"] = code });
        return code;
    }

    private static void Save(string path, int cursor) => File.WriteAllText(path, cursor.ToString(CultureInfo.InvariantCulture));

    private static string? Text(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string? ValueAfter(string[] args, string flag)
    {
        var index = Array.IndexOf(args, flag);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static JsonArray Strings(IEnumerable<string> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(JsonValue.Create(value));
        }
        return array;
    }

    private static JsonObject Variables()
    {
        var variables = new JsonObject();
        foreach (var name in Environment.GetEnvironmentVariables().Keys.Cast<string>().Order(StringComparer.Ordinal))
        {
            variables[name] = Environment.GetEnvironmentVariable(name);
        }
        return variables;
    }
}

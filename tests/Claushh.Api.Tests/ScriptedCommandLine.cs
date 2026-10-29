using Claushh.Api.Auth.Account;

namespace Claushh.Api.Tests;

// Answers the command's questions in order. An answer is computed when asked, so it can use what was printed before
// (the TOTP key).
public sealed class ScriptedCommandLine(ApiFactory api, params Func<ScriptedCommandLine, string?>[] answers) : ICommandLine
{
    private readonly Queue<Func<ScriptedCommandLine, string?>> _answers = new(answers);

    public List<string> Output { get; } = [];

    public string? ReadLine() => _answers.Count > 0 ? _answers.Dequeue()(this) : null;

    public string? ReadSecret() => ReadLine();

    public void WriteLine(string text) => Output.Add(text);

    public string PrintedKey() =>
        Output.Single(line => line.StartsWith("TOTP key: ", StringComparison.Ordinal))["TOTP key: ".Length..].Replace(" ", "");

    // Codes follow the test clock, like the API. Once accepted, the current code is used up; NextCode moves one step.
    public string CurrentCode() => Totp.Code(PrintedKey(), api.Clock.GetUtcNow());

    public string NextCode()
    {
        api.Clock.Advance(TimeSpan.FromSeconds(30));
        return CurrentCode();
    }
}

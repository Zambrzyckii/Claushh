// The operator's terminal for create-user (docs/ARCHITECTURE.md, "Backend", commands): what the command asks and
// prints. SystemCommandLine is the process's console and reads secrets without echo; the tests answer through
// ScriptedCommandLine.
using System.Text;

namespace Claushh.Api.Auth.Account;

public interface ICommandLine
{
    string? ReadLine();
    string? ReadSecret();
    void WriteLine(string text);
}

public sealed class SystemCommandLine : ICommandLine
{
    public static readonly SystemCommandLine Instance = new();

    public string? ReadLine() => Console.ReadLine();

    public void WriteLine(string text) => Console.WriteLine(text);

    // Without echo, so the password does not stay on the screen or in the terminal's scrollback.
    public string? ReadSecret()
    {
        var secret = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter)
            {
                Console.WriteLine();
                return secret.ToString();
            }
            if (key.Key == ConsoleKey.Backspace)
            {
                if (secret.Length > 0)
                {
                    secret.Length--;
                }
            }
            else if (!char.IsControl(key.KeyChar))
            {
                secret.Append(key.KeyChar);
            }
        }
    }
}

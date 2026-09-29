// `create-user` and `create-user --reset-totp`: the only way to create the single account or replace its TOTP key.
// There is no registration endpoint (docs/ARCHITECTURE.md, "Backend", commands).
using System.Text;
using Claushh.Api.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Auth;

public interface ITerminal
{
    string? ReadLine();
    string? ReadSecret();
    void WriteLine(string text);
}

public sealed class CreateUserCommand(ClaushhDbContext db, UserManager<IdentityUser> users, SessionService sessions, TotpVerifier totp)
{
    private const int CodeAttempts = 3;

    // One transaction: wrong codes or an interruption leave the database as it was.
    public async Task<int> RunAsync(bool resetTotp, ITerminal terminal, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var existing = await users.Users.FirstOrDefaultAsync(ct);
        IdentityUser? user;
        if (resetTotp)
        {
            user = existing;
            if (user is null)
            {
                return Fail(terminal, "There is no account yet. Run create-user without --reset-totp.");
            }
        }
        else
        {
            if (existing is not null)
            {
                return Fail(terminal, $"The account '{existing.UserName}' already exists. Use --reset-totp to replace its TOTP key.");
            }
            user = await CreateAccountAsync(terminal);
            if (user is null)
            {
                return 1;
            }
        }
        if (!await EnrollTotpAsync(user, terminal))
        {
            return Fail(terminal, "Wrong code. Nothing was changed.");
        }
        if (resetTotp)
        {
            await sessions.RevokeAllAsync(user.Id, ct);
        }
        await transaction.CommitAsync(ct);
        terminal.WriteLine(resetTotp ? "New TOTP key saved, all sessions ended." : $"Account '{user.UserName}' created.");
        return 0;
    }

    private async Task<IdentityUser?> CreateAccountAsync(ITerminal terminal)
    {
        terminal.WriteLine("User name:");
        var userName = terminal.ReadLine()?.Trim();
        terminal.WriteLine("Password (at least 12 characters):");
        var password = terminal.ReadSecret();
        terminal.WriteLine("Repeat the password:");
        if (string.IsNullOrEmpty(userName) || string.IsNullOrEmpty(password) || password != terminal.ReadSecret())
        {
            Fail(terminal, "Empty user name, or the passwords differ.");
            return null;
        }
        var user = new IdentityUser(userName);
        var result = await users.CreateAsync(user, password);
        if (!result.Succeeded)
        {
            Fail(terminal, string.Join(" ", result.Errors.Select(e => e.Description)));
            return null;
        }
        return user;
    }

    // TOTP is switched on only after a code from the app matches, so a mistyped key cannot lock the owner out.
    private async Task<bool> EnrollTotpAsync(IdentityUser user, ITerminal terminal)
    {
        await users.ResetAuthenticatorKeyAsync(user);
        var key = await users.GetAuthenticatorKeyAsync(user) ?? throw new InvalidOperationException("No TOTP key.");
        var uri = $"otpauth://totp/Claushh:{Uri.EscapeDataString(user.UserName!)}?secret={key}&issuer=Claushh&digits=6";
        terminal.WriteLine($"TOTP key: {string.Join(' ', key.Chunk(4).Select(part => new string(part)))}");
        terminal.WriteLine($"URI: {uri}");
        terminal.WriteLine($"QR code in the terminal: qrencode -t ansiutf8 '{uri}'");
        for (var attempt = 0; attempt < CodeAttempts; attempt++)
        {
            terminal.WriteLine("Code from the app:");
            var code = terminal.ReadLine()?.Trim();
            if (code is not null && await totp.VerifyAsync(user, code))
            {
                await users.SetTwoFactorEnabledAsync(user, true);
                return true;
            }
        }
        return false;
    }

    private static int Fail(ITerminal terminal, string message)
    {
        terminal.WriteLine(message);
        return 1;
    }
}

public sealed class ConsoleTerminal : ITerminal
{
    public static readonly ConsoleTerminal Instance = new();

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

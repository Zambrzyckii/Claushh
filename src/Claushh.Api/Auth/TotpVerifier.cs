// Checks TOTP codes from an authenticator app (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) against TimeProvider and
// accepts each code once (docs/ARCHITECTURE.md, "Backend", "Login protection"). Identity's validator is not used: it
// allows ±2 steps with the real clock and has no reuse check.
using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

public sealed class TotpVerifier(UserManager<IdentityUser> users, TimeProvider clock)
{
    private const string TokenProvider = "Claushh";
    private const string LastStepToken = "TotpLastStep";
    private const long StepSeconds = 30;

    // True for a code of the step before, of or after now that is newer than the last accepted code. That step is then
    // stored, so neither this code nor an older one works again (RFC 6238, section 5.2).
    public async Task<bool> VerifyAsync(IdentityUser user, string code)
    {
        if (code.Length != 6 || !code.All(char.IsAsciiDigit) || await users.GetAuthenticatorKeyAsync(user) is not { } key)
        {
            return false;
        }
        var secret = FromBase32(key);
        var lastStep = await users.GetAuthenticationTokenAsync(user, TokenProvider, LastStepToken) is { } stored
            ? long.Parse(stored, CultureInfo.InvariantCulture)
            : long.MinValue;
        var now = clock.GetUtcNow().ToUnixTimeSeconds() / StepSeconds;
        for (var step = now - 1; step <= now + 1; step++)
        {
            if (step > lastStep && CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(Code(secret, step)), Encoding.ASCII.GetBytes(code)))
            {
                var result = await users.SetAuthenticationTokenAsync(user, TokenProvider, LastStepToken,
                    step.ToString(CultureInfo.InvariantCulture));
                if (!result.Succeeded)
                {
                    throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
                }
                return true;
            }
        }
        return false;
    }

    private static string Code(byte[] secret, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        var hash = HMACSHA1.HashData(secret, counter);
        var offset = hash[^1] & 0x0F;
        var value = (BinaryPrimitives.ReadInt32BigEndian(hash.AsSpan(offset)) & 0x7FFFFFFF) % 1_000_000;
        return value.ToString("D6", CultureInfo.InvariantCulture);
    }

    // The key as Identity stores it: base32 (RFC 4648), without padding. Identity has no public decoder.
    private static byte[] FromBase32(string key)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var bytes = new List<byte>(key.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in key.TrimEnd('=').ToUpperInvariant())
        {
            var value = alphabet.IndexOf(c, StringComparison.Ordinal);
            if (value < 0)
            {
                throw new FormatException("The stored TOTP key is not base32.");
            }
            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits >= 8)
            {
                bits -= 8;
                bytes.Add((byte)(buffer >> bits));
                buffer &= (1 << bits) - 1;
            }
        }
        return [.. bytes];
    }
}

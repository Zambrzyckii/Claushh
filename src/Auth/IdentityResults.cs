// Turns an IdentityResult that failed into an InvalidOperationException with Identity's error descriptions, the same way
// everywhere in Auth.
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

internal static class IdentityResults
{
    public static void ThrowIfFailed(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }
}

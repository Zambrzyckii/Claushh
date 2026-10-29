// The text rule every reader of project files shares (docs/ARCHITECTURE.md, "Files and editor"): no NUL byte, strict
// UTF-8, a leading BOM dropped, and the 5 MB limit. The files API, search, git's HEAD content and the terminal theme
// use it.
using System.Text;

namespace Claushh.Api.Projects;

public static class TextRule
{
    public const int MaxBytes = 5 * 1024 * 1024;

    internal static readonly byte[] Bom = [0xEF, 0xBB, 0xBF];
    internal static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    // What the editor shows for the bytes of a file: null for a NUL byte or invalid UTF-8, otherwise the text without a
    // leading UTF-8 BOM. The size limit (MaxBytes) is up to the caller.
    internal static string? DecodeText(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Contains((byte)0))
        {
            return null;
        }
        try
        {
            return StrictUtf8.GetString(bytes[(HasBom(bytes) ? Bom.Length : 0)..]);
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    internal static bool HasBom(ReadOnlySpan<byte> bytes) => bytes.StartsWith(Bom);
}

// The terminal's colours for GET /api/terminal/theme (docs/ARCHITECTURE.md, "Terminal" → "Terminal theme API contract";
// "Backend" → "Terminal"; decision: docs/PLAN.md, "Interface"): the 19 colours of the pywal colors.json that
// Terminal:ThemeFile names, read on every request. Anything else is no theme (null). Nothing of the file, its path or a
// parse error's message (it would quote the file) is returned or logged.
using System.Text.Json;
using Claushh.Api.Files;

namespace Claushh.Api.Terminal;

public sealed record TerminalTheme(string Background, string Foreground, string Cursor, IReadOnlyList<string> Palette)
{
    public const int MaxBytes = 16 * 1024;

    private static readonly string[] Special = ["background", "foreground", "cursor"];

    // null: no path, not a readable regular file (a link is followed), over MaxBytes, not a JSON object in UTF-8, or one
    // of the 19 values missing or not "#" and 6 hex digits.
    public static TerminalTheme? Read(string? path)
    {
        if (string.IsNullOrEmpty(path) || Libc.OpenRegularFile(path) is not { } file)
        {
            return null;
        }
        // One byte over the limit is enough to refuse the file; the size it reports is never asked.
        var bytes = new byte[MaxBytes + 1];
        int read;
        try
        {
            using var stream = new FileStream(file, FileAccess.Read, bufferSize: 0);
            read = stream.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false);
        }
        catch (IOException)
        {
            return null;
        }
        finally
        {
            file.Dispose();
        }
        if (read > MaxBytes || FileStore.DecodeText(bytes.AsSpan(0, read)) is not { } text)
        {
            return null;
        }
        try
        {
            using var json = JsonDocument.Parse(text);
            return FromPywal(json.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // special.background, special.foreground, special.cursor and colors.color0 … colors.color15, in lower case.
    private static TerminalTheme? FromPywal(JsonElement root)
    {
        if (Section(root, "special") is not { } special || Section(root, "colors") is not { } colors)
        {
            return null;
        }
        string[] values =
        [
            .. Special.Select(name => Colour(special, name)).OfType<string>(),
            .. Enumerable.Range(0, 16).Select(i => Colour(colors, $"color{i}")).OfType<string>(),
        ];
        return values.Length == 19 ? new TerminalTheme(values[0], values[1], values[2], values[3..]) : null;
    }

    private static JsonElement? Section(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var section)
        && section.ValueKind == JsonValueKind.Object
            ? section
            : null;

    // The value in lower case; null when it is missing, not a string, or not "#" and 6 hex digits.
    private static string? Colour(JsonElement section, string name) =>
        section.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
        && value.GetString() is { Length: 7 } colour && colour[0] == '#' && colour.Skip(1).All(char.IsAsciiHexDigit)
            ? colour.ToLowerInvariant()
            : null;
}

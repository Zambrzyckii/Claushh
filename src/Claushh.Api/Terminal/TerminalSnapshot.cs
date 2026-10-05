// The text Attach returns (docs/ARCHITECTURE.md, "Backend" → "Terminal"): history and screen as tmux has them, with
// colours, joined by CRLF (the view has no convertEol), then the cursor and the modes the view's reset() cleared.
using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Terminal;

public static class TerminalSnapshot
{
    public const int MaxLength = 1_000_000;

    private const string Format = "#{cursor_x},#{cursor_y},#{cursor_flag},#{keypad_cursor_flag},#{keypad_flag},"
        + "#{bracket_paste_flag},#{mouse_standard_flag},#{mouse_button_flag},#{mouse_all_flag},#{mouse_sgr_flag},"
        + "#{alternate_on},#{alternate_saved_x},#{alternate_saved_y},#{scroll_region_upper},#{scroll_region_lower},"
        + "#{history_size},#{pane_height}";

    // The cursor, the modes and the sizes of a pane, in the order of Format.
    public sealed record Display(int CursorX, int CursorY, bool CursorVisible, bool KeypadCursor, bool Keypad,
        bool BracketedPaste, bool MouseStandard, bool MouseButton, bool MouseAll, bool MouseSgr, bool AlternateOn,
        int SavedX, int SavedY, int ScrollUpper, int ScrollLower, int HistorySize, int Height)
    {
        public static Display Parse(TmuxReply reply)
        {
            // tmux prints alternate_saved_x/y as an unsigned 32-bit number (4294967295 for "unset", i.e. -1 as u_int)
            // while the pane is not in the alternate screen, so every field is parsed as long first and then narrowed;
            // the narrowing recovers -1 for the unset case, which is never read since AlternateStart is not called then.
            string[] values = reply.Lines.Count == 1 ? reply.Text(0).Split(',') : [];
            if (values.Length != 17 || !values.All(value => long.TryParse(value, CultureInfo.InvariantCulture, out _)))
            {
                throw new HubException(TmuxServer.Unresponsive);
            }
            var v = Array.ConvertAll(values, value => unchecked((int)long.Parse(value, CultureInfo.InvariantCulture)));
            return new(v[0], v[1], v[2] == 1, v[3] == 1, v[4] == 1, v[5] == 1, v[6] == 1, v[7] == 1, v[8] == 1, v[9] == 1,
                v[10] == 1, v[11], v[12], v[13], v[14], v[15], v[16]);
        }
    }

    // The usual case, on one line so screen, modes and seq agree: the modes, then history and screen with wrapped lines
    // joined (the view wraps them again at the same width).
    public static string NormalCommands(string pane) =>
        $"display-message -p -t {pane} '{Format}' ; capture-pane -p -e -J -t {pane} -S - -E -";

    // While a program shows the alternate screen: the capture line by line (history_size lines of history, then
    // pane_height lines of the alternate screen) and the normal screen tmux keeps meanwhile.
    public static string AlternateCommands(string pane) =>
        $"display-message -p -t {pane} '{Format}' ; capture-pane -p -e -N -t {pane} -S - -E - ; "
        + $"capture-pane -a -q -p -e -N -t {pane}";

    public static string Normal(Display display, IReadOnlyList<byte[]> lines, string open) => Build(Decode(lines), null, display, open);

    // After a resize tmux keeps the normal screen at the height it had when the program switched: a shorter one is padded
    // with empty lines, a taller one is written whole (its top lines scroll into the view's history).
    public static string Alternate(Display display, IReadOnlyList<byte[]> lines, IReadOnlyList<byte[]> normalScreen, string open, ILogger log)
    {
        var all = Decode(lines);
        if (all.Count != display.HistorySize + display.Height)
        {
            log.LogWarning("capture-pane gave {Lines} lines for a history of {History} and a screen of {Height}",
                all.Count, display.HistorySize, display.Height);
            return Build(all, null, display, open);
        }
        var normal = Decode(normalScreen);
        while (normal.Count < display.Height)
        {
            normal.Add("");
        }
        return Build([.. all.Take(display.HistorySize), .. normal], [.. all.Skip(display.HistorySize)], display, open);
    }

    // `open`: the escape sequence the output was inside at the capture (EscapeTail), last, after the cursor and modes. Too
    // long for one message: the oldest lines go first, those of the history and normal screen before those of the
    // alternate screen, so the text is never longer than MaxLength.
    private static string Build(List<string> main, List<string>? alternate, Display display, string open)
    {
        var start = alternate is null ? "" : AlternateStart(display);
        var end = Tail(display) + open;
        alternate ??= [];
        var length = start.Length + end.Length + Joined(main) + Joined(alternate);
        var fromMain = 0;
        while (length > MaxLength && fromMain < main.Count)
        {
            length -= main[fromMain].Length + (fromMain < main.Count - 1 ? 2 : 0);
            fromMain++;
        }
        var fromAlternate = 0;
        while (length > MaxLength && fromAlternate < alternate.Count)
        {
            length -= alternate[fromAlternate].Length + (fromAlternate < alternate.Count - 1 ? 2 : 0);
            fromAlternate++;
        }
        var text = new StringBuilder(length);
        text.AppendJoin("\r\n", main.Skip(fromMain)).Append(start).AppendJoin("\r\n", alternate.Skip(fromAlternate));
        return text.Append(end).ToString();
    }

    // Where the normal screen's cursor was when the program switched, so leaving the alternate screen puts it back.
    // ESC[0m first, so the normal screen's last colour does not leak into the alternate screen.
    private static string AlternateStart(Display d) => $"\e[0m\e[{d.SavedY + 1};{d.SavedX + 1}H\e[?1049h\e[H";

    private static string Tail(Display d)
    {
        var tail = new StringBuilder("\e[0m");
        if (d.ScrollUpper != 0 || d.ScrollLower != d.Height - 1)
        {
            tail.Append(CultureInfo.InvariantCulture, $"\e[{d.ScrollUpper + 1};{d.ScrollLower + 1}r");
        }
        tail.Append(CultureInfo.InvariantCulture, $"\e[{d.CursorY + 1};{d.CursorX + 1}H");
        if (!d.CursorVisible)
        {
            tail.Append("\e[?25l");
        }
        if (d.KeypadCursor)
        {
            tail.Append("\e[?1h");
        }
        if (d.Keypad)
        {
            tail.Append("\e=");
        }
        if (d.BracketedPaste)
        {
            tail.Append("\e[?2004h");
        }
        if (d.MouseStandard)
        {
            tail.Append("\e[?1000h");
        }
        if (d.MouseButton)
        {
            tail.Append("\e[?1002h");
        }
        if (d.MouseAll)
        {
            tail.Append("\e[?1003h");
        }
        if (d.MouseSgr)
        {
            tail.Append("\e[?1006h");
        }
        return tail.ToString();
    }

    private static int Joined(List<string> lines) => lines.Sum(line => line.Length) + Math.Max(0, lines.Count - 1) * 2;

    private static List<string> Decode(IReadOnlyList<byte[]> lines) => [.. lines.Select(line => Encoding.UTF8.GetString(line))];
}

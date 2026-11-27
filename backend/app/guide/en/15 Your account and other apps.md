# Your account and other apps

Back to [[00 Welcome|Welcome]].

## The settings

The gear at the bottom of the sidebar opens the settings, on a phone your picture at the top right. Under **My account** is what concerns only you: Profile, Security, Appearance, Notes, Spaces, Plugins, AI, Notifications and Connections. The operator also sees **Server**, with everything that holds for all accounts.

## Signing in

You sign in with your username or with your mail address once it counts (see [[09 Sharing and rights#Your mail address]]).

- **Forgot your password?** shows on the sign-in page when the operator has set up a mail server. nexlore then sends a link to your address, with which you set a new password. It holds for an hour and works once. Afterwards you are signed out in every browser; passkeys and API keys stay. Without a mail server the operator makes you such a link.
- **Passkeys:** under **My account › Security**, **Add a passkey** makes one. From then on **Sign in with a passkey** signs you in with your fingerprint, face or the PIN of your device, without a password. Passkeys are there once nexlore runs at an address with https and the operator allows them (Settings › Server › Sign-in, on from the start). A passkey counts as a second factor too.
- **Mail me about a new sign-in:** when somebody signs in from a browser nexlore does not know yet, you get a mail. You switch that off under **My account › Security**.

## Notes from nexnotes

nexnotes is a nex app of its own for quick notes. What you jot down there and want to keep, you put into a space of nexlore with one click: in nexnotes, **To nexlore** in the menu of a note, then choose the space. The note arrives as a new note with its title and text; in nexnotes it stays as it is.

For that you connect the two apps once, with no key to type:

1. Under **My account › Connections**, **Other nex apps** has the card **nexnotes**.
2. There you choose which spaces nexnotes may put notes into: all, including later ones, or only some. Only spaces you may write in are offered.
3. **Connect with nexnotes** opens nexnotes. You sign in there, see what nexnotes may do and agree once. Then you are back here.

If you start in nexnotes, nexlore asks you for the same spaces on the page where you agree.

> [!note] What nexnotes may do
> Exactly one thing: put notes into the spaces you gave it. nexnotes sees your account and the names of those spaces, never what your notes say, and it cannot change, move or delete anything.

The card shows which account in nexnotes you are connected with, since when, when nexnotes last brought something and which spaces it uses. **End access** ends the connection on both sides; what is in nexlore already stays.

If the card says nexnotes is not set up on this server, it is the operator's turn: the operator enters the address of nexnotes once under **Settings › Server › General › Other nex apps**, and from then on every account connects with one click. If nexnotes runs in the local network (LAN, VPN), the operator also allows **Connections into the local network** there. The switch **Connections with other nex apps** lets every connection rest; nothing is deleted. API keys for programs such as n8n keep working as before, see [[11 AI]].

## For the operator: accounts

Under **Settings › Server › Accounts** every account has a line with **Manage**. There:

- **Block** takes away every way in; everything in the account stays. **Unblock** lets it in again; earlier sign-ins stay ended.
- **Delete account** takes it away for everybody at once. For 30 days **Restore** brings it back, with its spaces and rights. After that it is deleted for good: its notes stay where they are, and a space it was the only member of then belongs to the operator.
- **Link for a new password** makes a link with which the person sets a new password; you never set a password for anybody. With a mail server the link goes to their address, otherwise nexlore shows it to you once to pass on.
- A **mail address** everybody enters themselves; you can only remove it.
- You also set the account's **Storage limit** and whether it may use AI.

You do not block or delete your own account here, and there is always an operator left who can sign in.

That was the guide. Enjoy your notes. Back to [[00 Welcome|Welcome]].

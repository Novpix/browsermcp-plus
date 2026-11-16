# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**
(<https://github.com/Novpix/browsermcp-plus/security/advisories/new>).
Do not open a public issue for a security problem.

Include the version, your browser and operating system, and the steps that
show the problem. We will look at every report and keep you informed, but we
cannot promise a fix or a timeline.

## Supported versions

Fixes go into the latest release only. Update to it before you report.

## In scope

- The local server accepting connections from the network, or from origins
  other than the extension.
- A web page driving the browser, or reading data, through the extension or
  the server.
- An agent reaching tabs that are neither its own nor lent to it.
- Password fields being typed into or read.

## Out of scope

- What an agent does with the access you give it, including actions caused
  by text on a web page that misleads the model (prompt injection). That is a
  limitation of every browser agent: see the
  [disclaimer](README.md#disclaimer). Report it if browsermcp-plus makes it
  worse than it has to be.
- A program on your computer that already runs as you.

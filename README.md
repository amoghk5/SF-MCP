# sf-mcp-server

MCP server for SAP SuccessFactors APIs

## Overview

`sf-mcp-server` is a small Node.js MCP (Model Context Protocol) adapter that provides helper tools and resources to connect to SAP SuccessFactors via OData. It's intended as a lightweight server-side component to be used with MCP clients and other integration tooling.

## Features

- Manage and persist connection aliases (`ConnectionRegistry`).
- Session and auth helpers under `src/auth`.
- Utilities for querying, upserting, and metadata access under `src/tools` and `src/resources`.

## Requirements

- Node.js 16+ (ES module support)

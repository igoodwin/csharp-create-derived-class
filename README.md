# C# Create Derived Class

Adds a Code Action for C# files that generates a new derived class based on the class declaration at the cursor.

## How to Use

1. Open any `.cs` file in VS Code.
2. Place the cursor on the line containing `class MyBase` (or on the class name itself).
3. A lightbulb/Code Action will appear with the option: **Create derived class 'MyBaseDerived'**.
4. Select the action and enter a name for the new class (default: `MyBaseDerived`).
5. A new `.cs` file will be created in the same folder and automatically opened.
6. The cursor will be positioned at the `// TODO: implement` line so you can immediately start writing code.

## Features

- Detects the class name at the cursor position.
- Suggests a default name for the derived class.
- Automatically detects and applies the namespace from the source file.
- Creates the new file next to the original one.
- Opens the file and places the cursor at the main implementation point.

## Build

```bash
npm install
npm run compile


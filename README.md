# C# Create Derived Class

Adds a Code Action for C# files that generates a derived class based on the selected base class.  
The generated class includes constructors, abstract member overrides, generic handling, and cursor positioning for faster editing.

---

## ✨ Features

### 🔹 Create derived class
When the cursor is on a class declaration, a Code Action appears:
> **Create derived class `MyBaseDerived`**

The extension will:
- detect the class name automatically
- suggest `<BaseClassName>Derived` as the default derived name
- detect namespace
- create a `.cs` file in the same folder
- open the file and position cursor at the main implementation point

### 🔹 Generic class support
Works with:
```csharp
class MyBase<T>
````

Generated:

```csharp
class MyBaseDerived : MyBase<T>
```

Multi-cursor is automatically placed on generic parameters for batch editing.

### 🔹 Constructor generation

If the base class has constructors with parameters, corresponding constructors are generated:

Base:

```csharp
public MyBase(int x, string name) { }
```

Generated:

```csharp
public MyBaseDerived(int x, string name) : base(x, name)
{
}
```

Supports:

* reference modifiers (`ref`, `in`, `out`)
* default parameter values
* constructors with different accessibility (`public`, `protected`, etc.)

### 🔹 Abstract method generation

Base:

```csharp
public abstract Task ProcessAsync(int id);
protected abstract TResult Transform<T>(T data) where T : class;
```

Generated:

```csharp
public override Task ProcessAsync(int id)
{
    throw new System.NotImplementedException();
}

protected override TResult Transform<T>(T data) where T : class
{
    throw new System.NotImplementedException();
}
```

Supports:

* generic methods
* constraints `where T : ...`
* return types including generic return types

### 🔹 Abstract property generation

Base:

```csharp
public abstract T Data { get; set; }
public abstract string Name { get; }
public abstract int Count { get; init; }
```

Generated:

```csharp
public override T Data { get; set; }

public override string Name { get; }

public override int Count { init; }
```

---

### 🔹 Interface extraction suggestions

Place the caret on a public property or method (including generic members).  
The extension will offer quick fixes to:

- add the member to any existing interface in the file
- or create a brand-new interface (name prefilled from the containing class)
- keep interface declarations generic if the member uses class type parameters
- automatically change private method implementations to `public` so they match the interface contract

Members already declared in an interface, and interface members themselves, are ignored.

### 🔹 Move members to base class

If a class inherits from another class declared in the same file, place the caret on any field, property, or method to get the quick fix:
> **Move 'MemberName' to BaseClass**

The action will:
- move the selected member along with other class members it depends on
- automatically change `private` accessibility to `protected` so the base class can use the member
- remove the members from the derived class and insert them before the closing brace of the base class
- show the standard VS Code preview so you can review the diff before applying

---

## ▶ How to Use

1. Open any `.cs` file
2. Move the cursor to a line like:

```csharp
public class MyBase
```

3. Press:

* **Ctrl+.**
* **Alt+Enter**
* or click the 💡 lightbulb

4. Choose:

> Create derived class 'MyBaseDerived'

5. Enter name if necessary
6. The extension will create and open a new file

---

## 🔧 Build and Debug

```bash
npm install
npm run compile
```

Press **F5** to launch extension development host.

---

## 🧪 Installation from VSIX

After packaging:

```bash
vsce package
```

Then:

```bash
code --install-extension *.vsix
```

---

## 📄 License

MIT

---

# 📌 Changelog
## 0.0.7 - Minor fixes
* Added namespace supporting

## 0.0.6 — Interface suggestions & base moves

* Added Roslyn/OmniSharp-powered detection of properties and methods for quick interface extraction
* Can append to existing interfaces or generate new ones with inferred generic parameters
* Ensures private methods become `public` when an interface is introduced
* New “Move members to base class” refactor moves selected members plus their dependencies, promoting `private` to `protected` when needed

## 0.0.5 — Minor fixes

## 0.0.4 — Added abstract property generation

* Added support for generating overrides for abstract properties
* Handles `get`, `set`, and `init` accessors
* All NotImplemented blocks use expression bodies

## 0.0.3 — Added abstract method generation

* Generates overrides for abstract methods
* Supports generic abstract methods
* Supports `where` constraints

## 0.0.2 — Constructor generation

* Detects base constructors with arguments
* Generates matching constructors with `base(...)` call
* Preserves modifiers `ref/out/in`, and default values

## 0.0.1 — Initial release

* Generates derived class from base class
* Detects namespace automatically
* Multi-cursor positioning on generic parameters
* Suggestion for default derived class name
* Cursor positioned at implementation location

---

```
```

public class TestClass
{
    public int Data { get; set; }
    public bool IsValid {get; }
}

public class TestClass<T> : TestClass
{
    public T Value { get; set; }
}


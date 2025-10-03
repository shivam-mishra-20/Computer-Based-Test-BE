# AI Math Formatting Guide for Teachers/Admins

## 🎯 Purpose

This guide helps you ensure that the AI generates questions with perfect mathematical notation using LaTeX formatting. Add these instructions to the **Guidance** system in your admin panel for specific subjects/topics.

---

## 📋 Quick Guidance Templates

### For Mathematics Subject

```
MANDATORY LATEX FORMATTING FOR ALL MATH:
- Wrap ALL mathematical expressions in LaTeX: $expression$ for inline, $$expression$$ for display
- Use \frac{a}{b} for fractions, never "a/b"
- Use \int for integrals with proper bounds: \int_a^b
- Use \cos, \sin, \tan, \log, \ln (with backslash) never plain text
- Use ^ for superscripts: x^2, e^x (use braces for multi-char: x^{2n})
- Use _ for subscripts: x_1, a_{ij}
- Greek letters: \alpha, \beta, \pi, \theta, \Sigma, etc.

EXAMPLES (Follow exactly):
✓ "Find $\int (1 - x)\, dx$"
✓ "Solve $x^2 + 5x + 6 = 0$"
✓ "If $\cos^2(x) = \frac{1}{2}$, find $x$"
✓ "Evaluate $$\int_0^\pi \sin(x)\, dx$$"

❌ NEVER: "Find ∫(1-x)dx", "x^2+5x+6=0", "cos²(x)=1/2"
```

### For Physics Subject

```
MANDATORY LATEX FOR ALL FORMULAS & EQUATIONS:
- Physical quantities with units: $5\text{ m/s}^2$, $E = mc^2$
- Greek symbols: $\omega$ (omega), $\alpha$ (alpha), $\theta$ (theta)
- Vectors: $\vec{v}$, $\vec{F}$
- Subscripts for components: $v_x$, $F_{\text{net}}$

EXAMPLES:
✓ "If $F = ma$ and $m = 2\text{ kg}$, $a = 5\text{ m/s}^2$..."
✓ "The kinetic energy is $KE = \frac{1}{2}mv^2$"
✓ "Angular velocity $\omega = \frac{2\pi}{T}$"

❌ NEVER: "F=ma", "KE=(1/2)mv²", "ω=2π/T"
```

### For Chemistry Subject

```
MANDATORY LATEX FOR CHEMICAL & MATH EXPRESSIONS:
- Chemical formulas: $H_2O$, $CO_2$, $C_6H_{12}O_6$
- Equations with states: $2H_2 + O_2 \to 2H_2O$
- Concentrations: $[H^+]$, $K_{eq}$
- Math in chemistry: $pH = -\log[H^+]$
- Molarity: $M = \frac{n}{V}$ where $n$ is moles

EXAMPLES:
✓ "Calculate the pH if $[H^+] = 10^{-3}\text{ M}$"
✓ "For the reaction $N_2 + 3H_2 \to 2NH_3$..."
✓ "Molarity $M = \frac{10\text{ mol}}{2\text{ L}} = 5\text{ M}$"

❌ NEVER: "H2O", "[H+]=10^-3M", "N2+3H2→2NH3"
```

---

## 🔍 Common Math Formatting Issues & Fixes

### Issue 1: Plain Text Integrals

❌ **Wrong**: "Find ∫(1-x)dx"  
✅ **Correct**: "Find $\int (1 - x)\, dx$"

**Guidance to add**:

```
ALL integrals must use \int with proper spacing (\,) before dx.
Format: $\int f(x)\, dx$ or $\int_a^b f(x)\, dx$
```

### Issue 2: Fractions as Division

❌ **Wrong**: "Simplify (x^2-1)/(x-1)"  
✅ **Correct**: "Simplify $\frac{x^2-1}{x-1}$"

**Guidance to add**:

```
NEVER use "/" for fractions in questions. Always use \frac{numerator}{denominator}
Example: $\frac{a+b}{c}$ not "(a+b)/c"
```

### Issue 3: Plain Trigonometric Functions

❌ **Wrong**: "Evaluate cos²(x)"  
✅ **Correct**: "Evaluate $\cos^2(x)$"

**Guidance to add**:

```
ALL trig functions require backslash: \sin, \cos, \tan, \sec, \csc, \cot
For powers: \sin^2(x), \cos^{-1}(x) (inverse cosine)
```

### Issue 4: Missing Exponent Braces

❌ **Wrong**: "$x^2n$" (renders as x²n)  
✅ **Correct**: "$x^{2n}$" (renders as x²ⁿ)

**Guidance to add**:

```
For multi-character exponents, use braces: x^{2n}, e^{-x^2}, (x+1)^{10}
Single char exponents don't need braces: x^2, e^x, a^n
```

### Issue 5: Logarithms

❌ **Wrong**: "log(x)", "ln(x)"  
✅ **Correct**: "$\log(x)$", "$\ln(x)$", "$\log_{10}(x)$"

**Guidance to add**:

```
Logarithms: \log, \ln, \log_{base}
Examples: $\ln(e^x) = x$, $\log_2(8) = 3$
```

### Issue 6: Square Roots

❌ **Wrong**: "sqrt(x)", "√x"  
✅ **Correct**: "$\sqrt{x}$", "$\sqrt[3]{x}$" (cube root)

**Guidance to add**:

```
Square roots: \sqrt{expression}
nth roots: \sqrt[n]{expression}
Examples: $\sqrt{x^2+y^2}$, $\sqrt[3]{27} = 3$
```

---

## 🎓 Subject-Specific Guidance Examples

### Calculus Course Guidance

```
SUBJECT: Mathematics - Calculus

CRITICAL LATEX REQUIREMENTS:
1. ALL derivatives must use proper notation:
   - Leibniz: $\frac{dy}{dx}$, $\frac{d^2y}{dx^2}$
   - Lagrange: $f'(x)$, $f''(x)$
   - Never: "dy/dx", "f'(x)" without $

2. ALL integrals with proper bounds and spacing:
   - Indefinite: $\int f(x)\, dx$
   - Definite: $\int_a^b f(x)\, dx$
   - Multiple: $\iint$, $\iiint$

3. Limits with proper notation:
   - $\lim_{x \to 0} f(x)$
   - $\lim_{x \to \infty} \frac{1}{x} = 0$

4. Common functions:
   - $\sin(x)$, $\cos(x)$, $\tan(x)$, $e^x$, $\ln(x)$

EXAMPLES OF PERFECT QUESTIONS:
- "Find $\frac{d}{dx}(x^3 + 2x^2 - 5)$"
- "Evaluate $\int_0^\pi \sin(x)\, dx$"
- "Calculate $\lim_{x \to 0} \frac{\sin(x)}{x}$"
- "If $y = e^{x^2}$, find $\frac{dy}{dx}$"
```

### Algebra Course Guidance

```
SUBJECT: Mathematics - Algebra

LATEX FORMATTING RULES:
1. Polynomials: $x^2 + 5x + 6$, $ax^2 + bx + c$
2. Fractions: $\frac{a}{b}$, $\frac{x^2-1}{x-1}$
3. Roots: $\sqrt{x}$, $\sqrt[3]{x}$, $\sqrt{x^2+y^2}$
4. Absolute value: $|x|$, $|x-3| < 5$
5. Inequalities: $\leq$, $\geq$, $\neq$

QUADRATIC FORMULA (use exactly):
$$x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$$

PERFECT EXAMPLES:
- "Solve $x^2 - 5x + 6 = 0$"
- "Simplify $\frac{x^2-4}{x+2}$"
- "Find $x$ if $|2x-1| = 5$"
- "Solve $x^2 + px + q = 0$ using the quadratic formula"
```

### Trigonometry Course Guidance

```
SUBJECT: Mathematics - Trigonometry

MANDATORY LATEX FOR TRIG:
1. Functions: $\sin$, $\cos$, $\tan$, $\cot$, $\sec$, $\csc$
2. Inverse functions: $\sin^{-1}$, $\cos^{-1}$, $\tan^{-1}$ OR $\arcsin$, $\arccos$, $\arctan$
3. Angles: $\theta$, $\alpha$, $\beta$, $\frac{\pi}{3}$, $30°$ or $30^\circ$
4. Identities must be perfectly formatted

KEY IDENTITIES (format exactly):
- $\sin^2(x) + \cos^2(x) = 1$
- $\tan(x) = \frac{\sin(x)}{\cos(x)}$
- $\sin(2x) = 2\sin(x)\cos(x)$
- $\cos(2x) = \cos^2(x) - \sin^2(x)$

EXAMPLES:
- "Prove $\sin^2(\theta) + \cos^2(\theta) = 1$"
- "If $\sin(x) = \frac{3}{5}$ and $0 < x < \frac{\pi}{2}$, find $\cos(x)$"
- "Solve $\tan^{-1}(x) = \frac{\pi}{4}$"
```

---

## 🔧 How to Add Guidance in Admin Panel

1. **Login** to admin panel
2. Go to **Guidance Management**
3. Click **Add New Guidance**
4. Fill in:
   - **Subject**: (e.g., "Mathematics", "Physics", "Chemistry")
   - **Topic**: (e.g., "Calculus", "Algebra", "Mechanics") - Optional for subject-wide rules
   - **Instructions**: Copy relevant guidance from above
5. **Activate** the guidance
6. **Test** by generating questions for that subject/topic

---

## ✅ Verification Checklist

After adding guidance, generate test questions and verify:

- [ ] All math expressions wrapped in $ or $$
- [ ] Fractions use \frac{}{} not /
- [ ] Integrals use \int with \, before dx
- [ ] Trig functions use \sin, \cos, \tan with backslash
- [ ] Greek letters formatted: \alpha, \pi, \theta
- [ ] Superscripts use ^{} with braces for multi-char
- [ ] Subscripts use \_{}
- [ ] No plain text math remains (x^2 ❌, $x^2$ ✅)

---

## 🚀 Quick Copy-Paste Guidance Templates

### Template 1: General Math (All Topics)

```
UNIVERSAL MATH LATEX RULES:
- Inline math: $expression$
- Display math: $$expression$$
- Fractions: \frac{a}{b}
- Powers: x^2, x^{2n}
- Roots: \sqrt{x}, \sqrt[n]{x}
- Greek: \alpha, \beta, \pi, \theta, \Sigma
- Functions: \sin, \cos, \log, \ln
- Comparison: \leq, \geq, \neq, \approx

NO PLAIN TEXT MATH ALLOWED. Every mathematical symbol, expression, or equation must be in LaTeX.
```

### Template 2: Strict Integer/Numerical Answers

```
For integer/numerical answer questions:
- Present the final answer in LaTeX if it contains math
- Example: "Answer: $x = 5$" not "Answer: x=5"
- For pure numbers: "Answer: 42" is acceptable
- For expressions: "Answer: $\frac{3\pi}{4}$" required
```

### Template 3: Multiple Choice Options with Math

```
MCQ OPTIONS FORMATTING:
Each option with math must have LaTeX:
✓ CORRECT format:
  a) $x = 2$
  b) $x = -3$
  c) $x = \frac{1}{2}$
  d) No real solution

❌ WRONG format:
  a) x=2
  b) x=-3
  c) x=1/2
```

---

## 📞 Support

If questions still generate with poor math formatting:

1. Check that guidance is **Active** and assigned to correct subject/topic
2. Verify guidance text doesn't have typos in LaTeX commands
3. Review generated questions and add specific "DON'T" examples to guidance
4. Test with simple prompts first, then increase complexity

---

**Remember**: The AI follows your guidance precisely. The more specific and example-rich your guidance, the better the output quality! 🎯

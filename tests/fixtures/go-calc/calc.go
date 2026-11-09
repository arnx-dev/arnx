// Package calc is a small library with one exported function per behaviour.
package calc

import "example.com/calc/internal/fee"

// Add returns the sum of a and b.
func Add(a, b int) int {
	return a + b
}

// Total returns an amount with its fee.
func Total(amount int) int {
	return amount + fee.Cents(amount)
}

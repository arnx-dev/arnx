// Package fee works out the charge on an amount.
package fee

// Cents is one percent of amount, rounded down.
func Cents(amount int) int {
	return amount / 100
}

import { Markdownifier } from '../src/cleaners/Markdownifier.js';

const tableHtml = `
<html>
<body>
<h1>Test Table</h1>
<table>
  <thead>
    <tr>
      <th>Name</th>
      <th>Age</th>
      <th>City</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Alice</td>
      <td>30</td>
      <td>New York</td>
    </tr>
    <tr>
      <td>Bob</td>
      <td>25</td>
      <td>Los Angeles</td>
    </tr>
    <tr>
      <td>Charlie</td>
      <td>35</td>
      <td>Chicago</td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;

const markdownifier = new Markdownifier();
const result = markdownifier.convert(tableHtml);

console.log('=== TABLE CONVERSION TEST ===\n');
console.log(result);
console.log('\n=== END TEST ===');

// Verify table structure
const hasTablePipes = result.includes('|');
const hasTableHeader = result.includes('Name') && result.includes('Age') && result.includes('City');
const hasTableData = result.includes('Alice') && result.includes('Bob') && result.includes('Charlie');

console.log('\n=== VERIFICATION ===');
console.log(`✓ Has table pipe characters: ${hasTablePipes}`);
console.log(`✓ Has table headers: ${hasTableHeader}`);
console.log(`✓ Has table data: ${hasTableData}`);

if (hasTablePipes && hasTableHeader && hasTableData) {
    console.log('\n✅ TABLE HANDLING WORKS CORRECTLY!');
} else {
    console.log('\n❌ TABLE HANDLING FAILED');
    process.exit(1);
}

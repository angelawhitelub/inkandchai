import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[2] / "scripts" / "create_listing_from_url.py"
SPEC = importlib.util.spec_from_file_location("create_listing_from_url", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class ListingMetadataTests(unittest.TestCase):
    def test_extracts_json_ld_book_metadata(self):
        source = """
        <html><head><script type="application/ld+json">
        {"@type":"Book","name":"Play Bigger","author":[{"name":"Al Ramadan"},{"name":"Dave Peterson"}],
         "description":"A category design strategy book.","isbn":"9780349414645","publisher":{"name":"Piatkus"}}
        </script></head></html>
        """
        result = MODULE.amazon_metadata_from_html(source)
        self.assertEqual(result["title"], "Play Bigger")
        self.assertEqual(result["authors"], "Al Ramadan, Dave Peterson")
        self.assertEqual(result["isbn"], "9780349414645")
        self.assertEqual(result["publisher"], "Piatkus")

    def test_merge_prefers_rendered_browser_values(self):
        result = MODULE.merge_metadata(
            {"title": "Rendered title", "authors": "", "description": "Rendered description"},
            {"title": "Meta title", "authors": "Book Author", "description": "Meta description"},
        )
        self.assertEqual(result["title"], "Rendered title")
        self.assertEqual(result["authors"], "Book Author")
        self.assertEqual(result["description"], "Rendered description")

    def test_isbn_from_amazon_url(self):
        self.assertEqual(
            MODULE.isbn_from_url("https://www.amazon.in/Play-Bigger/dp/0349414645/ref=test"),
            "0349414645",
        )


if __name__ == "__main__":
    unittest.main()
